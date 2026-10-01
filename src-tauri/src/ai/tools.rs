//! Function calling 工具定义与解析：
//! 模型通过 `propose_schedule_changes` 工具提出结构化修改方案，
//! 解析成 `ProposedChange` 后由用户确认，绝不自动落地。

use serde_json::{json, Value};

use crate::ai::types::ProposedChange;

const VALID_KINDS: [&str; 5] = ["update", "add", "complete", "delete", "reminder"];

pub fn proposal_tool_schema() -> Value {
    json!([{
        "type": "function",
        "function": {
            "name": "propose_schedule_changes",
            "description": "提出对用户任务计划的具体修改方案。仅生成建议，不会直接生效，用户确认后才应用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "operations": {
                        "type": "array",
                        "description": "要建议的修改操作列表",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {
                                    "type": "string",
                                    "enum": ["update", "add", "complete", "delete", "reminder"],
                                    "description": "update=修改现有任务；add=新增任务；complete=标记完成；delete=删除任务；reminder=创建提醒"
                                },
                                "task_id": {
                                    "type": "string",
                                    "description": "目标任务的 id（update/complete/delete 必填）"
                                },
                                "title": {"type": "string", "description": "任务标题（add 必填，update 可选）"},
                                "date": {"type": "string", "description": "日期，格式 YYYY-MM-DD"},
                                "start_time": {"type": "string", "description": "开始时间，格式 HH:mm（24 小时制）"},
                                "duration_minutes": {"type": "integer", "description": "预计时长（分钟）"},
                                "priority": {
                                    "type": "string",
                                    "enum": ["none", "low", "medium", "high"]
                                },
                                "category_name": {"type": "string", "description": "分类名称（不存在则新建分类）"},
                                "repeat": {
                                    "type": "string",
                                    "enum": ["none", "daily", "weekly", "weekdays"]
                                },
                                "notes": {"type": "string", "description": "备注（最多 50 字）"},
                                "minutes_before": {"type": "integer", "description": "提醒在开始前多少分钟（reminder 用）"},
                                "remind_at": {"type": "string", "description": "提醒的具体时间（ISO 8601，reminder 用，缺省时按任务开始时间推算）"},
                                "message": {"type": "string", "description": "提醒内容（reminder 用）"},
                                "reason": {"type": "string", "description": "这项建议的理由，用于向用户展示"}
                            },
                            "required": ["kind"]
                        }
                    }
                },
                "required": ["operations"]
            }
        }
    }])
}

/// 把模型返回的工具参数 JSON 解析成结构化修改建议。
pub fn parse_proposed_changes(arguments: &str) -> Result<Vec<ProposedChange>, String> {
    let value: Value =
        serde_json::from_str(arguments).map_err(|error| format!("JSON 解析失败：{error}"))?;
    let operations = value
        .get("operations")
        .and_then(Value::as_array)
        .ok_or_else(|| "缺少 operations 数组".to_string())?;

    let mut changes = Vec::new();
    for (index, operation) in operations.iter().enumerate() {
        changes.push(parse_change(operation, index)?);
    }
    Ok(changes)
}

fn parse_change(operation: &Value, index: usize) -> Result<ProposedChange, String> {
    let kind = operation
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !VALID_KINDS.contains(&kind.as_str()) {
        return Err(format!("第 {} 条操作 kind 无效：{kind}", index + 1));
    }

    let get_string = |key: &str| -> Option<String> {
        operation
            .get(key)
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    };
    let get_u32 = |key: &str| -> Option<u32> {
        operation.get(key).and_then(Value::as_u64).map(|v| v as u32)
    };

    let change = ProposedChange {
        kind,
        task_id: get_string("task_id"),
        title: get_string("title"),
        date: get_string("date"),
        start_time: get_string("start_time"),
        duration_minutes: get_u32("duration_minutes"),
        priority: get_string("priority"),
        category_name: get_string("category_name"),
        repeat: get_string("repeat"),
        notes: get_string("notes"),
        minutes_before: get_u32("minutes_before"),
        remind_at: get_string("remind_at"),
        message: get_string("message"),
        reason: get_string("reason"),
    };

    match change.kind.as_str() {
        "update" | "complete" | "delete" => {
            if change.task_id.is_none() {
                return Err(format!("第 {} 条操作缺少 task_id", index + 1));
            }
        }
        "add" => {
            if change.title.is_none() || change.date.is_none() {
                return Err(format!("第 {} 条新增操作缺少 title 或 date", index + 1));
            }
        }
        "reminder" => {
            if change.task_id.is_none() && change.remind_at.is_none() {
                return Err(format!(
                    "第 {} 条提醒操作需要 task_id 或 remind_at",
                    index + 1
                ));
            }
        }
        _ => {}
    }
    Ok(change)
}
