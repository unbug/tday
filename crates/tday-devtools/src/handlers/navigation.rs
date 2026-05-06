/// Navigation tools: window/app listing, focus, launch, quit, displays, OCR text search.

use crate::error::{DevToolsError, Result};
use crate::platform;
use serde_json::{json, Value};

// ──────────────────────────────────────────────────────────────────────────────

pub async fn handle_list_windows(_params: Value) -> Result<Value> {
    let windows = tokio::task::spawn_blocking(|| platform::list_windows())
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Other)?;
    let list: Vec<Value> = windows.iter().map(|w| json!({
        "id":          w.id,
        "name":        w.name,
        "owner_name":  w.owner_name,
        "owner_pid":   w.owner_pid,
        "bounds":      { "x": w.bounds.x, "y": w.bounds.y, "width": w.bounds.width, "height": w.bounds.height },
        "layer":       w.layer,
        "is_on_screen": w.is_on_screen,
    })).collect();
    Ok(json!({ "windows": list }))
}

pub async fn handle_list_apps(_params: Value) -> Result<Value> {
    let apps = tokio::task::spawn_blocking(|| platform::list_apps())
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?;
    let list: Vec<Value> = apps.iter().map(|a| json!({
        "name":        a.name,
        "bundle_id":   a.bundle_id,
        "pid":         a.pid,
        "is_active":   a.is_active,
        "is_hidden":   a.is_hidden,
        "is_user_app": a.is_user_app,
    })).collect();
    Ok(json!({ "apps": list }))
}

pub async fn handle_get_displays(_params: Value) -> Result<Value> {
    let displays = platform::get_displays().map_err(DevToolsError::Screenshot)?;
    let list: Vec<Value> = displays.iter().map(|d| json!({
        "id":                  d.id,
        "name":                d.name,
        "is_main":             d.is_main,
        "bounds":              { "x": d.bounds.x, "y": d.bounds.y, "width": d.bounds.width, "height": d.bounds.height },
        "backing_scale_factor": d.backing_scale_factor,
        "pixel_width":         d.pixel_width,
        "pixel_height":        d.pixel_height,
    })).collect();
    Ok(json!({ "displays": list }))
}

pub async fn handle_focus_window(params: Value) -> Result<Value> {
    let wid = params.get("window_id").and_then(|v| v.as_u64())
        .ok_or_else(|| DevToolsError::Input("window_id required".into()))? as u32;

    let win = tokio::task::spawn_blocking(move || platform::find_window_by_id_direct(wid))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Other)?;
    let w = win.ok_or(DevToolsError::WindowNotFound(wid))?;
    let pid = w.owner_pid as i32;
    let ok = tokio::task::spawn_blocking(move || {
        let _ = platform::raise_windows(pid);
        platform::activate_by_pid(pid)
    }).await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?;
    Ok(json!({ "ok": ok }))
}

pub async fn handle_launch_app(params: Value) -> Result<Value> {
    let name = params.get("app_name").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("app_name required".into()))?.to_string();
    let args: Vec<String> = params.get("args")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let bg = params.get("background").and_then(|v| v.as_bool()).unwrap_or(false);
    tokio::task::spawn_blocking(move || platform::launch_app(&name, &args, bg))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(|e| DevToolsError::AppNotFound(e))?;
    Ok(json!({ "ok": true }))
}

pub async fn handle_quit_app(params: Value) -> Result<Value> {
    let name = params.get("app_name").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("app_name required".into()))?.to_string();
    let force = params.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
    let count = tokio::task::spawn_blocking(move || platform::quit_app(&name, force))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(|e| DevToolsError::AppNotFound(e))?;
    Ok(json!({ "terminated": count }))
}

pub async fn handle_find_text(params: Value) -> Result<Value> {
    let query = params.get("text").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("text required".into()))?.to_string();
    let display_id: u32 = params.get("display_id").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let lang_correction = params.get("language_correction").and_then(|v| v.as_bool()).unwrap_or(true);
    let use_ax = params.get("use_ax").and_then(|v| v.as_bool()).unwrap_or(true);

    if use_ax {
        // Prefer AX text search for running apps (more precise)
        let res = tokio::task::spawn_blocking(move || platform::ax_find_text(&query, None))
            .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
            .unwrap_or_default();
        let list: Vec<Value> = res.iter().map(match_to_json).collect();
        return Ok(json!({ "matches": list, "source": "ax" }));
    }

    // Fall back to OCR
    let res = tokio::task::spawn_blocking(move || platform::find_text_ocr(&query, Some(display_id), lang_correction))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Ocr)?;
    let list: Vec<Value> = res.iter().map(match_to_json).collect();
    Ok(json!({ "matches": list, "source": "ocr" }))
}

pub async fn handle_element_at_point(params: Value) -> Result<Value> {
    let x = params.get("x").and_then(|v| v.as_f64())
        .ok_or_else(|| DevToolsError::Input("x required".into()))?;
    let y = params.get("y").and_then(|v| v.as_f64())
        .ok_or_else(|| DevToolsError::Input("y required".into()))?;
    let app = params.get("app_name").and_then(|v| v.as_str()).map(|s| s.to_string());

    let info = tokio::task::spawn_blocking(move || platform::element_at_point(x, y, app.as_deref()))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Accessibility)?;

    Ok(json!({
        "role":        info.role,
        "name":        info.name,
        "value":       info.value,
        "description": info.description,
        "bounds":      info.bounds.map(|b| json!({ "x": b.x, "y": b.y, "width": b.width, "height": b.height })),
        "pid":         info.pid,
    }))
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

fn match_to_json(m: &crate::platform::types::TextMatch) -> Value {
    json!({
        "text":       m.text,
        "x":          m.x,
        "y":          m.y,
        "confidence": m.confidence,
        "bounds": { "x": m.bounds.x, "y": m.bounds.y, "width": m.bounds.width, "height": m.bounds.height },
        "role":       m.role,
    })
}

/// Resize and/or move an application's main window.
///
/// Parameters:
///   app_name           – name of the running application (required)
///   x, y               – new top-left position (optional)
///   width, height      – new size (optional)
pub async fn handle_resize_window(params: Value) -> Result<Value> {
    let app_name = params.get("app_name").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("app_name required".into()))?.to_string();
    let x      = params.get("x").and_then(|v| v.as_f64());
    let y      = params.get("y").and_then(|v| v.as_f64());
    let width  = params.get("width").and_then(|v| v.as_f64());
    let height = params.get("height").and_then(|v| v.as_f64());

    if x.is_none() && y.is_none() && width.is_none() && height.is_none() {
        return Err(DevToolsError::Input("at least one of x, y, width, height must be provided".into()));
    }

    tokio::task::spawn_blocking(move || platform::resize_window(&app_name, x, y, width, height))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Input)?;
    Ok(json!({ "ok": true }))
}