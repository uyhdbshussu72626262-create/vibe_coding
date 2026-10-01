//! 任务规划快照的构建与分析/修改提示词。
//! 默认不发送任务备注（隐私），并限制为最近 14 天或 300 条任务，取较小者。

use chrono::{Duration, Local, NaiveDate};
use serde_json::{json, Value};

use crate::db::Snapshot;
use crate::ai::types::ChatMode;

const MAX_TASKS: usize = 300;

pub fn build_plan_context(snapshot: &Snapshot) -> Value {
    let today = Local::now().date_naive();
    let today_key = today.format("%Y-%m-%d").to_string();
    let min_key = (today - Duration::days(2)).format("%Y-%m-%d").to_string();
    let max_key = (today + Duration::days(14)).format("%Y-%m-%d").to_string();

    let active_tasks: Vec<&Value> = snapshot
        .tasks
        .iter()
        .filter(|task| task.get("status").and_then(Value::as_str) != Some("trashed"))
        .collect();

    let mut windowed: Vec<&Value> = active_tasks
        .iter()
        .filter_map(|task| {
            let date = task.get("date").and_then(Value::as_str)?;
            (date >= min_key.as_str() && date <= max_key.as_str()).then_some(*task)
        })
        .collect();

    // 超出上限时先收窄到“今天起 14 天”，仍超出则截断并统计聚合数据。
    let mut truncated = false;
    if windowed.len() > MAX_TASKS {
        windowed = windowed
            .into_iter()
            .filter(|task| {
                task.get("date")
                    .and_then(Value::as_str)
                    .map(|date| date >= today_key.as_str())
                    .unwrap_or(false)
            })
            .collect();
        if windowed.len() > MAX_TASKS {
            windowed.sort_by(|a, b| {
                let a_date = a.get("date").and_then(Value::as_str).unwrap_or("");
                let b_date = b.get("date").and_then(Value::as_str).unwrap_or("");
                let a_order = a.get("order").and_then(Value::as_i64).unwrap_or(0);
                let b_order = b.get("order").and_then(Value::as_i64).unwrap_or(0);
                a_date.cmp(b_date).then(a_order.cmp(&b_order))
            });
            windowed.truncate(MAX_TASKS);
            truncated = true;
        }
    }

    let tasks_json: Vec<Value> = windowed
        .iter()
        .map(|task| {
            let category_name = snapshot
                .categories
                .iter()
                .find(|category| {
                    category.get("id").and_then(Value::as_str)
                        == task.get("categoryId").and_then(Value::as_str)
                })
                .and_then(|category| category.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            json!({
                "id": task.get("id").unwrap_or(&Value::Null),
                "title": task.get("title").unwrap_or(&Value::Null),
                "date": task.get("date").unwrap_or(&Value::Null),
                "startTime": task.get("startTime").unwrap_or(&Value::Null),
                "durationMinutes": task.get("durationMinutes").unwrap_or(&Value::Null),
                "priority": task.get("priority").unwrap_or(&Value::Null),
                "category": category_name,
                "repeat": task.get("repeat").unwrap_or(&Value::Null),
                "status": task.get("status").unwrap_or(&Value::Null),
                "subtasks": task
                    .get("subtasks")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| {
                                let title = item.get("title")?.as_str()?;
                                Some(json!({
                                    "title": title,
                                    "done": item.get("done").and_then(Value::as_bool).unwrap_or(false),
                                }))
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect();

    let stats = aggregate_stats(&active_tasks, &today);

    json!({
        "now": Local::now().to_rfc3339(),
        "today": today_key,
        "window": { "from": min_key, "to": max_key },
        "task_limit_reached": truncated,
        "stats": stats,
        "categories": snapshot
            .categories
            .iter()
            .filter_map(|category| {
                Some(json!({
                    "id": category.get("id")?.as_str()?,
                    "name": category.get("name")?.as_str()?,
                }))
            })
            .collect::<Vec<_>>(),
        "tasks": tasks_json,
    })
}

fn aggregate_stats(tasks: &[&Value], today: &NaiveDate) -> Value {
    let total = tasks.len();
    let completed = tasks
        .iter()
        .filter(|task| task.get("status").and_then(Value::as_str) == Some("completed"))
        .count();
    let pending = total - completed;

    let mut per_day: Vec<Value> = Vec::new();
    for offset in 0..7i64 {
        let date = (*today - Duration::days(offset)).format("%Y-%m-%d").to_string();
        let day_total = tasks
            .iter()
            .filter(|task| task.get("date").and_then(Value::as_str) == Some(date.as_str()))
            .count();
        let day_done = tasks
            .iter()
            .filter(|task| {
                task.get("date").and_then(Value::as_str) == Some(date.as_str())
                    && task.get("status").and_then(Value::as_str) == Some("completed")
            })
            .count();
        per_day.push(json!({
            "date": date,
            "total": day_total,
            "completed": day_done,
        }));
    }

    json!({
        "total_tasks": total,
        "completed": completed,
        "pending": pending,
        "completion_rate": if total > 0 {
            ((completed as f64 / total as f64) * 100.0).round() as u32
        } else {
            0
        },
        "last_7_days": per_day,
    })
}

/// 针对不同模式构造系统提示词（中文 / 英文）。
pub fn mode_system_prompt(mode: ChatMode, language: &str) -> String {
    let zh = language != "en";
    match mode {
        ChatMode::Chat => String::new(),
        ChatMode::AnalyzeToday => {
            if zh {
                "你是专业的个人时间管理助手。请分析下方「今日任务快照」中用户今天的安排是否合理：\
                 时间是否冲突、任务量是否过载、优先级与精力分配是否合适、是否缺少休息缓冲。\
                 请给出具体、可执行的文字建议。只做分析和建议，不要声称自己会直接修改。"
                    .to_string()
            } else {
                "You are a professional personal time-management assistant. Analyze the user's plan \
                 for today in the 'plan snapshot' below: conflicts, overload, priority balance and breaks. \
                 Give concrete, actionable suggestions in plain text only. Do not claim to modify anything."
                    .to_string()
            }
        }
        ChatMode::AnalyzeWeek => {
            if zh {
                "你是专业的个人时间管理助手。请分析下方「任务规划快照」中用户接下来一周的安排：\
                 整体工作量、deadline 风险、任务积压、日程是否过密。请给出分天或分主题的改进建议。\
                 只做分析和建议，不要声称自己会直接修改。"
                    .to_string()
            } else {
                "You are a professional personal time-management assistant. Analyze the upcoming week \
                 in the 'plan snapshot' below: workload, deadline risks, backlog and density. \
                 Give concrete suggestions in plain text only. Do not claim to modify anything."
                    .to_string()
            }
        }
        ChatMode::ProposeChanges => {
            if zh {
                "你是专业的个人时间管理助手。请结合下方「任务规划快照」，\
                 通过调用 propose_schedule_changes 工具提出对任务计划的修改方案，\
                 帮助用户更合理地安排时间（调整时间/优先级、拆分或合并、增删任务、设置提醒）。\
                 每条操作必须填写 reason 说明理由。注意：只通过工具提出建议，用户确认后才会生效。\
                 没有把握时宁可少改，不要编造不存在的任务 id。"
                    .to_string()
            } else {
                "You are a professional personal time-management assistant. Based on the 'plan snapshot' \
                 below, propose schedule changes by calling the propose_schedule_changes tool \
                 (adjust times/priorities, add/remove tasks, set reminders). Every operation must include \
                 a reason. Only propose via the tool; nothing is applied until the user confirms. \
                 Do not invent task ids that are not in the snapshot."
                    .to_string()
            }
        }
    }
}

/// 快照以“上下文消息”形式附加在对话中，避免污染可编辑的系统提示词。
pub fn context_system_prompt(snapshot: &Snapshot, language: &str) -> String {
    let context = build_plan_context(snapshot);
    let serialized = serde_json::to_string(&context).unwrap_or_else(|_| "{}".to_string());
    if language == "en" {
        format!(
            "Plan snapshot (JSON). Task notes are omitted for privacy. \
             Task ids are stable references for tool calls.\n{}",
            serialized
        )
    } else {
        format!(
            "任务规划快照（JSON）。出于隐私，任务备注已省略。\
             任务 id 是稳定引用，工具调用时请直接使用。\n{}",
            serialized
        )
    }
}
