// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

/// Accessibility tree handlers: snapshot, click, set_value, select, find_text via AX.

use crate::error::{DevToolsError, Result};
use crate::platform;
use crate::session::AxSession;
use serde_json::{json, Value};
use std::sync::Arc;

// ──────────────────────────────────────────────────────────────────────────────

pub async fn handle_take_ax_snapshot(params: Value, ax: Arc<AxSession>) -> Result<Value> {
    let app_name = params.get("app_name").and_then(|v| v.as_str()).map(|s| s.to_string());
    let pid: Option<i32> = params.get("pid").and_then(|v| v.as_i64()).map(|v| v as i32);

    let pid = tokio::task::spawn_blocking(move || -> Result<i32> {
        if let Some(p) = pid { return Ok(p); }
        if let Some(name) = &app_name {
            return platform::find_app_pid(name)
                .ok_or_else(|| DevToolsError::AppNotFound(name.clone()));
        }
        // front-most
        Ok(platform::frontmost_pid().map_err(|e| DevToolsError::Other(e))?)
    }).await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?? ;

    let (root, refs) = tokio::task::spawn_blocking(move || platform::take_snapshot(pid, 0))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Accessibility)?;

    let gen = ax.create_snapshot(refs).await;

    // Re-label uid fields with proper generation
    let root_json = relabel_uids(serde_json::to_value(&root)
        .map_err(|e| DevToolsError::Other(format!("json: {e}")))?, gen);

    Ok(json!({ "tree": root_json, "generation": gen }))
}

pub async fn handle_ax_click(params: Value, ax: Arc<AxSession>) -> Result<Value> {
    let uid = get_str(&params, "uid")?;
    ax.dispatch(&uid, |ax_ref| {
        platform::ax_click(ax_ref).map_err(DevToolsError::Accessibility)
    }).await
        .map_err(|e| DevToolsError::Accessibility(e.to_string()))?
        .map(|_| json!({ "ok": true }))
}

pub async fn handle_ax_set_value(params: Value, ax: Arc<AxSession>) -> Result<Value> {
    let uid = get_str(&params, "uid")?;
    let val = get_str(&params, "value")?;
    ax.dispatch(&uid, move |ax_ref| {
        platform::ax_set_value(ax_ref, &val).map_err(DevToolsError::Accessibility)
    }).await
        .map_err(|e| DevToolsError::Accessibility(e.to_string()))?
        .map(|_| json!({ "ok": true }))
}

pub async fn handle_ax_select(params: Value, ax: Arc<AxSession>) -> Result<Value> {
    let uid = get_str(&params, "uid")?;
    ax.dispatch(&uid, |ax_ref| {
        platform::ax_select(ax_ref).map_err(DevToolsError::Accessibility)
    }).await
        .map_err(|e| DevToolsError::Accessibility(e.to_string()))?
        .map(|_| json!({ "ok": true }))
}

pub async fn handle_ax_perform_action(params: Value, ax: Arc<AxSession>) -> Result<Value> {
    let uid    = get_str(&params, "uid")?;
    let action = get_str(&params, "action")?;
    ax.dispatch(&uid, move |ax_ref| {
        platform::ax_perform_action(ax_ref, &action).map_err(DevToolsError::Accessibility)
    }).await
        .map_err(|e| DevToolsError::Accessibility(e.to_string()))?
        .map(|_| json!({ "ok": true }))
}

// ──────────────────────────────────────────────────────────────────────────────
// ax_find — targeted search, returns only matching elements (with UIDs)
// ──────────────────────────────────────────────────────────────────────────────

/// Search the AX / UIA tree for elements matching `text` and/or `role` without
/// performing a full tree dump.  Matched elements are registered in the
/// AxSession so `ax_click` / `ax_set_value` / `ax_perform_action` can be
/// called immediately using the returned UIDs.
///
/// Parameters:
///   text        – substring to search in label/value/description (optional)
///   role        – role substring filter, e.g. "button", "textfield" (optional)
///   app_name    – target app; defaults to frontmost
///   pid         – target process id (overrides app_name)
///   max_results – max elements returned (default 20)
pub async fn handle_ax_find(params: Value, ax: Arc<AxSession>) -> Result<Value> {
    let text    = params.get("text").and_then(|v| v.as_str()).map(|s| s.to_string());
    let role    = params.get("role").and_then(|v| v.as_str()).map(|s| s.to_string());
    let app_name = params.get("app_name").and_then(|v| v.as_str()).map(|s| s.to_string());
    let pid_opt: Option<i32> = params.get("pid").and_then(|v| v.as_i64()).map(|v| v as i32);
    let max = params.get("max_results").and_then(|v| v.as_u64()).unwrap_or(20) as usize;

    if text.is_none() && role.is_none() {
        return Err(DevToolsError::Input("at least one of 'text' or 'role' is required".into()));
    }

    let pid = tokio::task::spawn_blocking(move || -> Result<i32> {
        if let Some(p) = pid_opt { return Ok(p); }
        if let Some(name) = &app_name {
            return platform::find_app_pid(name)
                .ok_or_else(|| DevToolsError::AppNotFound(name.clone()));
        }
        platform::frontmost_pid().map_err(DevToolsError::Other)
    }).await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?? ;

    let text2 = text.clone();
    let role2 = role.clone();
    let (nodes, refs) = tokio::task::spawn_blocking(move || {
        platform::ax_find_elements(
            pid,
            text2.as_deref(),
            role2.as_deref(),
            max,
            0, // generation placeholder
        )
    }).await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Accessibility)?;

    let gen = ax.create_snapshot(refs).await;

    let elements: Vec<Value> = nodes.into_iter().map(|n| {
        let uid = relabel_uid_str(&n.uid, gen);
        let mut obj = serde_json::to_value(&n).unwrap_or(Value::Null);
        if let Value::Object(ref mut m) = obj {
            m.insert("uid".into(), Value::String(uid));
        }
        obj
    }).collect();

    Ok(json!({
        "elements":   elements,
        "generation": gen,
        "query": {
            "text": text,
            "role": role,
        }
    }))
}

// ──────────────────────────────────────────────────────────────────────────────
// ax_focused — get the currently focused element (cheapest AX query)
// ──────────────────────────────────────────────────────────────────────────────

/// Return the system-wide focused AX element as a single slim node.
/// Registers it in the AxSession so `ax_set_value` can be called immediately.
///
/// Use this instead of `take_ax_snapshot` when you just need to interact with
/// whatever the user has already focused (e.g., type into the active text field).
pub async fn handle_ax_focused(params: Value, ax: Arc<AxSession>) -> Result<Value> {
    let _ = params; // no parameters needed
    let result = tokio::task::spawn_blocking(move || platform::ax_get_focused(0))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Accessibility)?;

    match result {
        None => Ok(json!({ "focused": null, "message": "no element is focused" })),
        Some((node, refs)) => {
            let gen = ax.create_snapshot(refs).await;
            let uid = relabel_uid_str(&node.uid, gen);
            let mut obj = serde_json::to_value(&node)
                .map_err(|e| DevToolsError::Other(format!("json: {e}")))?;
            if let Value::Object(ref mut m) = obj {
                m.insert("uid".into(), Value::String(uid));
            }
            Ok(json!({ "focused": obj, "generation": gen }))
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

fn get_str(v: &Value, key: &str) -> Result<String> {
    v.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
        .ok_or_else(|| DevToolsError::Input(format!("'{key}' (string) required")))
}

/// Rewrite a single uid string `"a<N>g<old>"` → `"a<N>g<gen>"`.
fn relabel_uid_str(s: &str, gen: u64) -> String {
    if let Some(rest) = s.strip_prefix('a') {
        if let Some(g) = rest.find('g') {
            let n = &rest[..g];
            if n.parse::<u32>().is_ok() {
                return format!("a{n}g{gen}");
            }
        }
    }
    s.to_string()
}

/// The snapshot builder in `platform::macos::ax` emits uids without generation
/// (e.g. "a3g0") because it doesn't know the generation at build time.
/// We rewrite them here with the real generation before sending to the client.
fn relabel_uids(v: Value, gen: u64) -> Value {
    match v {
        Value::String(s) => Value::String(relabel_uid_str(&s, gen)),
        Value::Object(mut map) => {
            // Only rewrite the "uid" field inside nodes
            if let Some(uid_val) = map.get("uid").cloned() {
                map.insert("uid".into(), relabel_uids(uid_val, gen));
            }
            for (_, v) in map.iter_mut() {
                *v = relabel_uids(std::mem::take(v), gen);
            }
            Value::Object(map)
        }
        Value::Array(arr) => {
            Value::Array(arr.into_iter().map(|v| relabel_uids(v, gen)).collect())
        }
        other => other,
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::relabel_uid_str;

    #[test]
    fn relabel_uid_str_rewrites_generation() {
        assert_eq!(relabel_uid_str("a42g0", 7), "a42g7");
        assert_eq!(relabel_uid_str("a0g1",  99), "a0g99");
    }

    #[test]
    fn relabel_uid_str_passthrough_on_bad_input() {
        assert_eq!(relabel_uid_str("bad", 5), "bad");
        assert_eq!(relabel_uid_str("",    5), "");
    }
}
