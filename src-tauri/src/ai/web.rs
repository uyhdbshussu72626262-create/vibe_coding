//! AI 助手的联网检索：搜索 + 抓取正文，再把资料交给模型。
//!
//! 采用开源方案 scraper（基于 html5ever）做 HTML 解析：
//! - 主通道：Bing 网页结果（含真实链接，片段更完整）
//! - 实时补充：Google News RSS
//! - 兜底：维基百科检索 API
//! 搜索结果再抓取前若干页面的正文，让模型读到实际内容而不是一句摘要。

use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE, engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde::Serialize;

use crate::ai::client::build_http_client;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_RESULTS: usize = 8;
const MAX_PAGE_TEXT: usize = 2200;

#[derive(Debug, Clone, Serialize)]
pub struct WebResult {
    pub title: String,
    /// 搜索引擎返回的短摘要，供“参考来源”列表展示。
    pub snippet: String,
    pub url: String,
    /// 抓取到的页面正文（可能为空）。
    pub text: String,
}

#[tauri::command]
pub async fn ai_web_search(query: String, limit: Option<u32>) -> Result<Vec<WebResult>, String> {
    let keyword = query.trim();
    if keyword.is_empty() {
        return Err("搜索内容不能为空".to_string());
    }
    let limit = limit.unwrap_or(5).clamp(1, MAX_RESULTS as u32) as usize;
    let client = build_http_client()?;

    let mut results = search_bing(&client, keyword, limit)
        .await
        .unwrap_or_default();

    if results.len() < 2 {
        if let Ok(news) = search_google_news(&client, keyword, limit).await {
            for item in news {
                if !results.iter().any(|r| r.url == item.url) {
                    results.push(item);
                }
            }
        }
    }

    if results.is_empty() {
        results = search_wikipedia(&client, keyword, limit).await?;
    }
    if results.is_empty() {
        return Err("没有找到相关结果".to_string());
    }

    // 抓取前两条页面的正文，让模型读到实际内容。
    let fetch_count = results.len().min(2);
    for result in results.iter_mut().take(fetch_count) {
        if let Ok(text) = fetch_readable_text(&client, &result.url).await {
            if text.len() >= 120 {
                result.text = text;
            }
        }
    }

    Ok(results.into_iter().take(limit).collect())
}

async fn search_bing(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<WebResult>, String> {
    let url = format!(
        "https://www.bing.com/search?q={}&count={}",
        url_encode(query),
        limit
    );
    let response = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|error| format!("Bing 请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("Bing 返回 HTTP {}", response.status().as_u16()));
    }
    let html = response.text().await.map_err(|error| error.to_string())?;
    Ok(parse_bing(&html, limit))
}

fn parse_bing(html: &str, limit: usize) -> Vec<WebResult> {
    let document = Html::parse_document(html);
    let Ok(item_sel) = Selector::parse("li.b_algo") else {
        return Vec::new();
    };
    let Ok(link_sel) = Selector::parse("h2 a") else {
        return Vec::new();
    };
    let Ok(caption_sel) = Selector::parse(".b_caption p, .b_caption") else {
        return Vec::new();
    };

    let mut results = Vec::new();
    for item in document.select(&item_sel).take(limit) {
        let Some(link) = item.select(&link_sel).next() else {
            continue;
        };
        let title = collapse_ws(&text_of(link));
        let url = link.value().attr("href").map(decode_bing_href).unwrap_or_default();
        if title.is_empty() || !url.starts_with("http") {
            continue;
        }
        let snippet = item
            .select(&caption_sel)
            .next()
            .map(text_of)
            .map(|t| collapse_ws(&t))
            .unwrap_or_default();
        results.push(WebResult {
            title,
            snippet,
            url,
            text: String::new(),
        });
    }
    results
}

/// Bing 结果链接形如 `.../ck/a?...&u=<base64url>...`，取 u 参数解码还原真实地址。
fn decode_bing_href(href: &str) -> String {
    let Some(start) = href.find("&u=") else {
        if href.starts_with("http") {
            return href.to_string();
        }
        return String::new();
    };
    let rest = &href[start + 3..];
    let end = rest.find('&').unwrap_or(rest.len());
    let encoded = &rest[..end];
    if let Ok(bytes) = URL_SAFE_NO_PAD.decode(encoded) {
        return String::from_utf8_lossy(&bytes).to_string();
    }
    if let Ok(bytes) = URL_SAFE.decode(encoded) {
        return String::from_utf8_lossy(&bytes).to_string();
    }
    String::new()
}

async fn search_google_news(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<WebResult>, String> {
    let url = format!(
        "https://news.google.com/rss/search?q={}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
        url_encode(query)
    );
    let response = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("Google News 请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Google News 返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let xml = response.text().await.map_err(|error| error.to_string())?;
    Ok(parse_rss_items(&xml, limit))
}

async fn search_wikipedia(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<WebResult>, String> {
    let host = if query.chars().any(|ch| ch as u32 > 0x2E80) {
        "zh.wikipedia.org"
    } else {
        "en.wikipedia.org"
    };
    let url = format!(
        "https://{host}/w/api.php?action=query&list=search&srsearch={}&srlimit={}&format=json&utf8=1",
        url_encode(query),
        limit
    );
    let response = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| format!("维基百科请求失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "维基百科返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let items = value["query"]["search"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    let mut results = Vec::new();
    for item in items.into_iter().take(limit) {
        let title = item["title"].as_str().unwrap_or("").to_string();
        if title.is_empty() {
            continue;
        }
        let snippet = strip_tags(item["snippet"].as_str().unwrap_or(""));
        results.push(WebResult {
            url: format!("https://{host}/wiki/{}", url_encode(&title.replace(' ', "_"))),
            title,
            snippet,
            text: String::new(),
        });
    }
    Ok(results)
}

/// 抓取网页正文：去掉脚本/样式，优先取 article/main，其次整个 body。
async fn fetch_readable_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type.to_lowercase().contains("html") {
        return Err("非 HTML 页面".to_string());
    }
    let html = response.text().await.map_err(|error| error.to_string())?;
    Ok(extract_readable(&html))
}

fn extract_readable(html: &str) -> String {
    let Ok(script_re) = Regex::new(r"(?is)<script[^>]*>.*?</script>") else {
        return String::new();
    };
    let Ok(style_re) = Regex::new(r"(?is)<style[^>]*>.*?</style>") else {
        return String::new();
    };
    let cleaned = script_re.replace_all(html, " ");
    let cleaned = style_re.replace_all(&cleaned, " ");
    let document = Html::parse_document(&cleaned);

    for tag in ["article", "main"] {
        if let Ok(selector) = Selector::parse(tag) {
            if let Some(node) = document.select(&selector).next() {
                let text = collapse_ws(&text_of(node));
                if text.len() >= 200 {
                    return truncate_chars(&text, MAX_PAGE_TEXT);
                }
            }
        }
    }
    if let Ok(selector) = Selector::parse("body") {
        if let Some(node) = document.select(&selector).next() {
            return truncate_chars(&collapse_ws(&text_of(node)), MAX_PAGE_TEXT);
        }
    }
    String::new()
}

fn text_of(element: ElementRef) -> String {
    element.text().collect::<Vec<_>>().join(" ")
}

fn collapse_ws(input: &str) -> String {
    input.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars: Vec<char> = value.chars().collect();
    if chars.len() <= max_chars {
        return value.to_string();
    }
    chars.truncate(max_chars);
    chars.into_iter().collect()
}

fn strip_tags(input: &str) -> String {
    let unescaped = input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ");
    let without_tags = match Regex::new(r"<[^>]*>") {
        Ok(re) => re.replace_all(&unescaped, " ").to_string(),
        Err(_) => unescaped,
    };
    collapse_ws(&without_tags)
}

fn url_encode(input: &str) -> String {
    let mut output = String::with_capacity(input.len() * 3);
    for byte in input.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            output.push(ch);
        } else if ch == ' ' {
            output.push('+');
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn parse_rss_items(xml: &str, limit: usize) -> Vec<WebResult> {
    let mut results = Vec::new();
    let mut cursor = 0usize;
    while results.len() < limit {
        let Some(start) = xml[cursor..].find("<item>").map(|offset| cursor + offset) else {
            break;
        };
        let Some(end) = xml[start..].find("</item>").map(|offset| start + offset) else {
            break;
        };
        let block = &xml[start..end];
        cursor = end + "</item>".len();
        let title = strip_tags(&extract_tag(block, "title").unwrap_or_default());
        let url = strip_tags(&extract_tag(block, "link").unwrap_or_default());
        let snippet = strip_tags(&extract_tag(block, "description").unwrap_or_default());
        if title.is_empty() || !url.starts_with("http") {
            continue;
        }
        results.push(WebResult {
            title,
            snippet,
            url,
            text: String::new(),
        });
    }
    results
}

fn extract_tag(block: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&close)? + start;
    Some(block[start..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_bing_redirect_href() {
        // "https://example.com/a" 的 base64url 编码
        let href = "https://www.bing.com/ck/a?!&&u=aHR0cHM6Ly9leGFtcGxlLmNvbS9h&ntb=1";
        assert_eq!(decode_bing_href(href), "https://example.com/a");
    }

    #[test]
    fn parses_bing_result_blocks() {
        let html = r#"
          <ol><li class="b_algo">
            <h2><a href="https://www.bing.com/ck/a?!&&u=aHR0cHM6Ly9leGFtcGxlLmNvbS9h&ntb=1">Example Title</a></h2>
            <div class="b_caption"><p>这是一段摘要</p></div>
          </li></ol>
        "#;
        let results = parse_bing(html, 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Example Title");
        assert_eq!(results[0].url, "https://example.com/a");
        assert_eq!(results[0].snippet, "这是一段摘要");
    }

    #[test]
    fn extracts_readable_body_without_scripts() {
        let html = r#"<html><head><style>.x{color:red}</style></head><body>
          <script>var a = 1;</script>
          <main><p>这是一段足够长的正文内容，用于测试正文提取是否能够正确去掉脚本和样式。</p>
          <p>第二段：介绍 Rust async 运行时 Tokio 的用法与生态。</p></main>
        </body></html>"#;
        let text = extract_readable(html);
        assert!(text.contains("正文内容"));
        assert!(!text.contains("var a"));
        assert!(!text.contains("color:red"));
    }

    #[test]
    fn url_encode_keeps_utf8_safe() {
        assert_eq!(url_encode("rust async"), "rust+async");
        assert_eq!(url_encode("中文"), "%E4%B8%AD%E6%96%87");
    }

    #[test]
    fn parses_rss_items() {
        let xml = r#"<rss><channel>
          <item><title>标题</title><link>https://example.com/x</link><description>&lt;b&gt;摘要&lt;/b&gt;</description></item>
        </channel></rss>"#;
        let results = parse_rss_items(xml, 5);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "标题");
        assert_eq!(results[0].url, "https://example.com/x");
        assert_eq!(results[0].snippet, "摘要");
    }

    /// 需要联网，默认忽略；用 `cargo test -- --ignored` 手动验证。
    #[tokio::test]
    #[ignore = "manual: requires network"]
    async fn live_search_returns_relevant_results() {
        let results = ai_web_search("rust async runtime".to_string(), Some(3))
            .await
            .expect("live search should succeed");
        assert!(!results.is_empty());
        assert!(results[0].url.starts_with("http"));
    }
}
