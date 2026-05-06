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
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

fn get_str(v: &Value, key: &str) -> Result<String> {
    v.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
        .ok_or_else(|| DevToolsError::Input(format!("'{key}' (string) required")))
}

/// The snapshot builder in `platform::macos::ax` emits uids without generation
/// (e.g. "a3g0") because it doesn't know the generation at build time.
/// We rewrite them here with the real generation before sending to the client.
fn relabel_uids(v: Value, gen: u64) -> Value {
    match v {
        Value::String(s) => {
            // uid pattern: "a<N>g<old_gen>"
            if let Some(rest) = s.strip_prefix('a') {
                if let Some(g) = rest.find('g') {
                    let n = &rest[..g];
                    if n.parse::<u32>().is_ok() {
                        return Value::String(format!("a{n}g{gen}"));
                    }
                }
            }
            Value::String(s)
        }
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
