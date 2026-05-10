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
    _max_depth: u32,
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
// ax_find_elements — OCR-based targeted search (AT-SPI2 stub)
// ──────────────────────────────────────────────────────────────────────────────

/// Find elements matching text_query on Linux via OCR.
/// Returns coordinate-based AXRefs that can be used with ax_click.
pub fn ax_find_elements(
    _pid: i32,
    text_query: Option<&str>,
    _role_filter: Option<&str>,
    max_results: usize,
    generation: u64,
) -> Result<(Vec<AXNode>, HashMap<u32, AXRef>), String> {
    let query = match text_query {
        Some(q) if !q.is_empty() => q,
        _ => return Ok((vec![], HashMap::new())),
    };

    let matches = super::ocr::find_text_ocr(query, None, false)?;
    let mut nodes: Vec<AXNode> = Vec::new();
    let mut refs:  HashMap<u32, AXRef> = HashMap::new();

    for (i, m) in matches.iter().take(max_results).enumerate() {
        let uid_n = i as u32;
        let bounds = Some(m.bounds.clone());
        refs.insert(uid_n, AXRef {
            bounds: bounds.clone(),
            role: m.role.as_deref().unwrap_or("Text").to_string(),
            name: Some(m.text.clone()),
        });
        nodes.push(AXNode {
            uid: format!("a{uid_n}g{generation}"),
            role: m.role.as_deref().unwrap_or("Text").to_string(),
            label: Some(m.text.clone()),
            value: None,
            description: None,
            bounds,
            enabled: Some(true),
            focused: None,
            children: vec![],
        });
    }

    Ok((nodes, refs))
}

// ──────────────────────────────────────────────────────────────────────────────
// ax_get_focused — get the currently focused element (xdotool stub)
// ──────────────────────────────────────────────────────────────────────────────

/// Return the focused element on Linux via xdotool.
/// Returns a stub AXNode with the focused window's process name.
pub fn ax_get_focused(
    generation: u64,
) -> Result<Option<(AXNode, HashMap<u32, AXRef>)>, String> {
    // Try to get the active window via xdotool
    let out = std::process::Command::new("xdotool")
        .args(["getactivewindow", "getwindowname"])
        .output();

    let window_title = out.ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    let pid = frontmost_pid().unwrap_or(0);
    let app_name = if pid > 0 { get_process_name(pid as u32) } else { None };

    // On Linux without full AT-SPI2, we can't identify the focused *element*,
    // only the active window.  Return a window-level stub.
    let node = AXNode {
        uid: format!("a0g{generation}"),
        role: "window".to_string(),
        label: window_title.or(app_name.clone()),
        value: None,
        description: app_name,
        bounds: None,
        enabled: Some(true),
        focused: Some(true),
        children: vec![],
    };

    let mut refs: HashMap<u32, AXRef> = HashMap::new();
    refs.insert(0, AXRef {
        bounds: None,
        role: "window".to_string(),
        name: node.label.clone(),
    });

    Ok(Some((node, refs)))
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

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── take_snapshot stub ────────────────────────────────────────────────────

    #[test]
    fn take_snapshot_returns_application_root() {
        // The stub creates a minimal root regardless of PID or max_depth.
        let (root, refs) = take_snapshot(99999, 42, u32::MAX).unwrap();
        assert_eq!(root.uid,  "a0g42");
        assert_eq!(root.role, "application");
        assert!(root.enabled == Some(true));
        assert!(root.children.is_empty());
        // Stub returns no refs (no live elements to register)
        assert!(refs.is_empty());
    }

    #[test]
    fn take_snapshot_honours_generation_in_uid() {
        let (root, _) = take_snapshot(1, 7, 3).unwrap();
        assert_eq!(root.uid, "a0g7");
    }

    #[test]
    fn take_snapshot_max_depth_ignored_by_stub() {
        // max_depth is accepted but the stub always returns the same structure
        let (root_full,  _) = take_snapshot(1, 1, u32::MAX).unwrap();
        let (root_zero,  _) = take_snapshot(1, 1, 0).unwrap();
        assert_eq!(root_full.uid,  root_zero.uid);
        assert_eq!(root_full.role, root_zero.role);
    }

    // ── ax_find_elements ──────────────────────────────────────────────────────

    #[test]
    fn ax_find_elements_returns_empty_when_no_text_query() {
        // None text_query → empty result (no OCR call needed)
        let (nodes, refs) = ax_find_elements(0, None, None, 20, 1).unwrap();
        assert!(nodes.is_empty());
        assert!(refs.is_empty());
    }

    #[test]
    fn ax_find_elements_returns_empty_for_empty_string_query() {
        let (nodes, refs) = ax_find_elements(0, Some(""), None, 20, 1).unwrap();
        assert!(nodes.is_empty());
        assert!(refs.is_empty());
    }

    // ── AXRef helpers ─────────────────────────────────────────────────────────

    #[test]
    fn axref_center_with_bounds() {
        let ax = AXRef {
            bounds: Some(Rect { x: 10.0, y: 20.0, width: 100.0, height: 40.0 }),
            role: "Button".into(),
            name: None,
        };
        let (cx, cy) = ax.center().unwrap();
        assert!((cx - 60.0).abs() < 1e-9);
        assert!((cy - 40.0).abs() < 1e-9);
    }

    #[test]
    fn axref_center_without_bounds_returns_none() {
        let ax = AXRef { bounds: None, role: "Text".into(), name: None };
        assert!(ax.center().is_none());
    }
}
