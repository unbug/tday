// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Linux accessibility via AT-SPI2 stub + coordinate-based AXRef.
//!
//! Full AT-SPI2 traversal requires the `atspi` crate (not yet in Cargo.toml).
//! This implementation provides:
//! - A coordinate-based AXRef type compatible with the macOS/Windows shape
//! - Coordinate-based ax_* action dispatch (same as Windows)
//! - An empty AX snapshot (graceful stub)
//! - element_at_point via xdotool/atspi-tools (best-effort)
//! - frontmost_pid / raise_windows / resize_window_by_pid via wmctrl/xdotool

use crate::platform::types::{AXNode, Rect, TextMatch};
use std::collections::HashMap;

/// Coordinate-based accessibility element reference.
#[derive(Clone, Debug)]
pub struct AXRef {
    pub bounds: Option<Rect>,
    pub role: String,
    pub name: Option<String>,
}

unsafe impl Send for AXRef {}
unsafe impl Sync for AXRef {}

impl AXRef {
    fn center(&self) -> Option<(f64, f64)> {
        self.bounds.as_ref().map(|b| (b.x + b.width / 2.0, b.y + b.height / 2.0))
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// AX snapshot (stub — returns an empty tree)
// ──────────────────────────────────────────────────────────────────────────────

pub fn take_snapshot(
    pid: i32,
    generation: u64,
) -> Result<(AXNode, HashMap<u32, AXRef>), String> {
    // AT-SPI2 full traversal would require atspi crate or dbus calls.
    // Return a minimal root node so callers don't break.
    let root = AXNode {
        uid: format!("a0g{generation}"),
        role: "application".to_string(),
        label: get_process_name(pid as u32),
        value: None,
        description: None,
        bounds: None,
        enabled: Some(true),
        focused: None,
        children: vec![],
    };
    Ok((root, HashMap::new()))
}

fn get_process_name(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
}

// ──────────────────────────────────────────────────────────────────────────────
// AX action dispatch (coordinate-based)
// ──────────────────────────────────────────────────────────────────────────────

pub fn ax_click(ax: &AXRef) -> Result<(), String> {
    let (x, y) = ax.center()
        .ok_or_else(|| "ax_click: no bounds".to_string())?;
    crate::platform::click(x, y, crate::platform::MouseButton::Left, 1)
        .map_err(|e| format!("ax_click failed: {e}"))
}

pub fn ax_set_value(ax: &AXRef, value: &str) -> Result<(), String> {
    if let Some((x, y)) = ax.center() {
        let _ = crate::platform::click(x, y, crate::platform::MouseButton::Left, 1);
        std::thread::sleep(std::time::Duration::from_millis(50));
        // Select all and type
        let _ = crate::platform::press_key("a", &["ctrl".to_string()]);
        std::thread::sleep(std::time::Duration::from_millis(20));
        crate::platform::type_text(value)
            .map_err(|e| format!("ax_set_value type_text failed: {e}"))
    } else {
        Err("ax_set_value: no bounds".to_string())
    }
}

pub fn ax_select(ax: &AXRef) -> Result<(), String> {
    let (x, y) = ax.center()
        .ok_or_else(|| "ax_select: no bounds".to_string())?;
    crate::platform::click(x, y, crate::platform::MouseButton::Left, 1)
        .map_err(|e| format!("ax_select failed: {e}"))
}

pub fn ax_perform_action(ax: &AXRef, action: &str) -> Result<(), String> {
    match action.to_lowercase().as_str() {
        "axpress" | "press" | "click" => ax_click(ax),
        "axshowmenu" | "showmenu" | "pick" => {
            let (x, y) = ax.center()
                .ok_or_else(|| "ax_perform_action: no bounds".to_string())?;
            crate::platform::click(x, y, crate::platform::MouseButton::Right, 1)
                .map_err(|e| format!("ax_perform_action context menu: {e}"))
        }
        _ => ax_click(ax),
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// ax_find_text — uses OCR as fallback
// ──────────────────────────────────────────────────────────────────────────────

pub fn ax_find_text(search: &str, _window_id: Option<u32>) -> Result<Vec<TextMatch>, String> {
    // AT-SPI2 full text search is complex; delegate to OCR for now
    super::ocr::find_text_ocr(search, None, false)
}

// ──────────────────────────────────────────────────────────────────────────────
// element_at_point (best-effort via xdotool)
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize)]
pub struct ElementInfo {
    pub name: Option<String>,
    pub role: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub bounds: Option<Rect>,
    pub pid: i32,
    pub app_name: Option<String>,
}

pub fn element_at_point(x: f64, y: f64, _app_name: Option<&str>) -> Result<ElementInfo, String> {
    // Use xdotool to identify the window under the cursor
    let out = std::process::Command::new("xdotool")
        .args(["getmouselocation", "--shell"])
        .output()
        .map_err(|e| format!("xdotool not found: {e}"))?;

    let mut pid = 0i32;
    let mut app_name = None;

    if out.status.success() {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Some(v) = line.strip_prefix("WINDOW=") {
                let win_id = u32::from_str_radix(v.trim(), 16).unwrap_or(0);
                if win_id != 0 {
                    if let Some(p) = get_window_pid(win_id) {
                        pid = p as i32;
                        app_name = get_process_name(pid as u32);
                    }
                }
            }
        }
    }

    Ok(ElementInfo {
        name: None,
        role: Some("unknown".to_string()),
        value: None,
        description: None,
        bounds: None,
        pid,
        app_name,
    })
}

fn get_window_pid(window_id: u32) -> Option<u32> {
    // Try /proc/net/tcp-based approach or xprop
    let out = std::process::Command::new("xprop")
        .args(["-id", &format!("{window_id}"), "_NET_WM_PID"])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout);
    // Output: _NET_WM_PID(CARDINAL) = 12345
    s.split('=').last()?.trim().parse::<u32>().ok()
}

// ──────────────────────────────────────────────────────────────────────────────
// Process / window management
// ──────────────────────────────────────────────────────────────────────────────

pub fn frontmost_pid() -> Result<i32, String> {
    // xdotool getactivewindow getwindowpid
    let out = std::process::Command::new("xdotool")
        .args(["getactivewindow", "getwindowpid"])
        .output()
        .map_err(|e| format!("xdotool not available: {e}"))?;

    if out.status.success() {
        let s = String::from_utf8_lossy(&out.stdout);
        let pid = s.trim().parse::<i32>().map_err(|e| format!("Parse PID: {e}"))?;
        return Ok(pid);
    }

    // Fallback: check WINDOWID env var
    if let Ok(wid) = std::env::var("WINDOWID") {
        if let Ok(wid_u) = wid.parse::<u32>() {
            if let Some(pid) = get_window_pid(wid_u) {
                return Ok(pid as i32);
            }
        }
    }

    Err("Could not determine frontmost PID".to_string())
}

pub fn pid_for_window(window_id: u32) -> Result<i32, String> {
    get_window_pid(window_id)
        .map(|p| p as i32)
        .ok_or_else(|| format!("No PID for window {window_id}"))
}

pub fn raise_windows(pid: i32) -> Result<(), String> {
    super::app::activate_by_pid(pid);
    Ok(())
}

pub fn resize_window_by_pid(
    pid: i32,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    if let Some(name) = get_process_name(pid as u32) {
        super::app::resize_window(&name, x, y, width, height)
    } else {
        Err(format!("No process for PID {pid}"))
    }
}
