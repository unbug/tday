// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

/// Mouse, keyboard, and cursor input handlers.

use crate::error::{DevToolsError, Result};
use crate::platform;
use crate::handlers::system::select_all_modifier;
use serde_json::{json, Value};
use std::time::Duration;

// ──────────────────────────────────────────────────────────────────────────────

pub async fn handle_move_mouse(params: Value) -> Result<Value> {
    let x = get_f64(&params, "x")?;
    let y = get_f64(&params, "y")?;
    // drag=true: drag from current position to (x, y)
    let drag = params.get("drag").and_then(|v| v.as_bool()).unwrap_or(false);
    if drag {
        tokio::task::spawn_blocking(move || {
            let (cx, cy) = platform::get_cursor_position()?;
            platform::drag(cx, cy, x, y, platform::MouseButton::Left)
        })
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Input)?;
    } else {
        tokio::task::spawn_blocking(move || platform::move_mouse(x, y))
            .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
            .map_err(DevToolsError::Input)?;
    }
    Ok(json!({ "ok": true }))
}

pub async fn handle_click(params: Value) -> Result<Value> {
    let x = get_f64(&params, "x")?;
    let y = get_f64(&params, "y")?;
    let btn_str = params.get("button").and_then(|v| v.as_str()).unwrap_or("left");
    let btn = parse_button(btn_str)?;
    let count = params.get("click_count").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    tokio::task::spawn_blocking(move || platform::click(x, y, btn, count))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Input)?;
    Ok(json!({ "ok": true }))
}

pub async fn handle_drag(params: Value) -> Result<Value> {
    let sx = get_f64(&params, "start_x")?;
    let sy = get_f64(&params, "start_y")?;
    let ex = get_f64(&params, "end_x")?;
    let ey = get_f64(&params, "end_y")?;
    let btn_str = params.get("button").and_then(|v| v.as_str()).unwrap_or("left");
    let btn = parse_button(btn_str)?;
    tokio::task::spawn_blocking(move || platform::drag(sx, sy, ex, ey, btn))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Input)?;
    Ok(json!({ "ok": true }))
}

/// Scroll at (x, y).
///
/// New direction+wheel_times API (preferred):
///   direction = "up"|"down"|"left"|"right"
///   wheel_times = number of wheel ticks (default 1)
///
/// Legacy delta API (still supported):
///   delta_x / delta_y
pub async fn handle_scroll(params: Value) -> Result<Value> {
    let x = get_f64(&params, "x")?;
    let y = get_f64(&params, "y")?;

    // Prefer the new direction + wheel_times API
    if let Some(dir) = params.get("direction").and_then(|v| v.as_str()) {
        let wheel_times = params.get("wheel_times").and_then(|v| v.as_u64()).unwrap_or(1) as i32;
        let (dx, dy) = match dir {
            "up"    => (0, -wheel_times),
            "down"  => (0,  wheel_times),
            "left"  => (-wheel_times, 0),
            "right" => ( wheel_times, 0),
            other   => return Err(DevToolsError::Input(format!("unknown direction '{other}'; use up/down/left/right"))),
        };
        tokio::task::spawn_blocking(move || platform::scroll(x, y, dx, dy))
            .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
            .map_err(DevToolsError::Input)?;
    } else {
        // Legacy delta API
        let dx = params.get("delta_x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let dy = params.get("delta_y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        tokio::task::spawn_blocking(move || platform::scroll(x, y, dx as i32, dy as i32))
            .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
            .map_err(DevToolsError::Input)?;
    }
    Ok(json!({ "ok": true }))
}

/// Type text at the current focus, with optional pre-click, clear, caret placement, and enter.
///
/// Parameters:
///   text            – string to type (required)
///   x, y            – if provided, click here first to focus the field
///   clear           – if true, select-all then delete before typing
///   caret_position  – "start" | "end" | "idle" (default: idle)
///   press_enter     – if true, press Return after typing
pub async fn handle_type_text(params: Value) -> Result<Value> {
    let text = params.get("text").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("text required".into()))?.to_string();
    let click_x = params.get("x").and_then(|v| v.as_f64());
    let click_y = params.get("y").and_then(|v| v.as_f64());
    let clear   = params.get("clear").and_then(|v| v.as_bool()).unwrap_or(false);
    let caret   = params.get("caret_position").and_then(|v| v.as_str()).unwrap_or("idle").to_string();
    let enter   = params.get("press_enter").and_then(|v| v.as_bool()).unwrap_or(false);

    tokio::task::spawn_blocking(move || {
        // 1. Click to focus if coordinates were given
        if let (Some(cx), Some(cy)) = (click_x, click_y) {
            platform::click(cx, cy, platform::MouseButton::Left, 1)?;
            std::thread::sleep(Duration::from_millis(100));
        }
        // 2. Clear field content (select-all then Delete).
        //    Use Cmd+A on macOS, Ctrl+A on Windows/Linux.
        if clear {
            platform::press_key("a", &[select_all_modifier().to_string()])?;
            std::thread::sleep(Duration::from_millis(50));
            platform::press_key("delete", &[])?;
            std::thread::sleep(Duration::from_millis(50));
        }
        // 3. Place caret using platform-appropriate keys.
        //    macOS:         Cmd+Left = line-start,  Cmd+Right = line-end
        //    Windows/Linux: Home = line-start,       End = line-end
        match caret.as_str() {
            "start" => {
                #[cfg(target_os = "macos")]
                platform::press_key("left", &["command".to_string()])?;
                #[cfg(not(target_os = "macos"))]
                platform::press_key("home", &[])?;
                std::thread::sleep(Duration::from_millis(20));
            }
            "end" => {
                #[cfg(target_os = "macos")]
                platform::press_key("right", &["command".to_string()])?;
                #[cfg(not(target_os = "macos"))]
                platform::press_key("end", &[])?;
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {} // "idle" — leave caret where it is
        }
        // 4. Type the text
        platform::type_text(&text)?;
        // 5. Optionally press Return
        if enter {
            std::thread::sleep(Duration::from_millis(20));
            platform::press_key("return", &[])?;
        }
        Ok::<(), String>(())
    })
    .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
    .map_err(DevToolsError::Input)?;
    Ok(json!({ "ok": true }))
}

pub async fn handle_press_key(params: Value) -> Result<Value> {
    let key = params.get("key").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("key required".into()))?.to_string();
    let mods: Vec<String> = params.get("modifiers")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    tokio::task::spawn_blocking(move || platform::press_key(&key, &mods))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Input)?;
    Ok(json!({ "ok": true }))
}

/// Execute a keyboard shortcut expressed as "modifier+key" (e.g. "command+c", "ctrl+shift+s").
/// The last token after splitting on '+' is treated as the key; all preceding tokens are modifiers.
pub async fn handle_shortcut(params: Value) -> Result<Value> {
    let shortcut = params.get("shortcut").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("shortcut required".into()))?.to_string();
    tokio::task::spawn_blocking(move || {
        let parts: Vec<&str> = shortcut.split('+').map(|s| s.trim()).collect();
        if parts.is_empty() {
            return Err("shortcut must not be empty".to_string());
        }
        let (key, mods) = if parts.len() == 1 {
            (parts[0].to_string(), vec![])
        } else {
            let key = parts.last().unwrap().to_string();
            let mods: Vec<String> = parts[..parts.len() - 1].iter().map(|s| s.to_string()).collect();
            (key, mods)
        };
        platform::press_key(&key, &mods)
    })
    .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
    .map_err(DevToolsError::Input)?;
    Ok(json!({ "ok": true }))
}

pub async fn handle_get_cursor_position(_params: Value) -> Result<Value> {
    let (x, y) = tokio::task::spawn_blocking(|| platform::get_cursor_position())
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Input)?;
    Ok(json!({ "x": x, "y": y }))
}

/// Find text on screen (via AX then OCR fallback) and click the centre of the
/// first match in a single tool call.
///
/// Parameters:
///   text        – the string to find and click (required)
///   button      – "left" | "right" | "middle" (default "left")
///   click_count – 1 | 2 (default 1; 2 = double-click)
///   app_name    – limit search to this app's window (optional)
///   use_ax      – prefer AX tree search (default true)
pub async fn handle_click_text(params: Value) -> Result<Value> {
    let text = params.get("text").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("text required".into()))?.to_string();
    let btn_str = params.get("button").and_then(|v| v.as_str()).unwrap_or("left").to_string();
    let count   = params.get("click_count").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    let use_ax  = params.get("use_ax").and_then(|v| v.as_bool()).unwrap_or(true);

    let btn = parse_button(&btn_str)?;

    let matches = tokio::task::spawn_blocking(move || -> std::result::Result<Vec<crate::platform::types::TextMatch>, String> {
        if use_ax {
            let res = platform::ax_find_text(&text, None).unwrap_or_default();
            if !res.is_empty() { return Ok(res); }
        }
        // OCR fallback
        platform::find_text_ocr(&text, None, true)
    }).await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Input)?;

    let first = matches.into_iter().next()
        .ok_or_else(|| DevToolsError::Input("text not found on screen".into()))?;

    let (x, y) = (first.x, first.y);
    tokio::task::spawn_blocking(move || platform::click(x, y, btn, count))
        .await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Input)?;

    Ok(json!({ "ok": true, "x": x, "y": y, "matched": first.text }))
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

fn get_f64(v: &Value, key: &str) -> Result<f64> {
    v.get(key).and_then(|v| v.as_f64())
        .ok_or_else(|| DevToolsError::Input(format!("'{key}' (f64) required")))
}

fn parse_button(s: &str) -> Result<platform::MouseButton> {
    match s {
        "left"   => Ok(platform::MouseButton::Left),
        "right"  => Ok(platform::MouseButton::Right),
        "middle" | "center" => Ok(platform::MouseButton::Center),
        other => Err(DevToolsError::Input(format!("unknown button '{other}'")))
    }
}
