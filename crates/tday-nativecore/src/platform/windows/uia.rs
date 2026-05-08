// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Windows UI Automation (UIA) accessibility tree and AX action dispatch.
//!
//! Provides:
//! - take_snapshot: Traverse UIA control tree and return an AXNode tree
//! - ax_click / ax_set_value / ax_select / ax_perform_action: Coordinate-based actions
//! - ax_find_text: Search UIA tree for elements containing text
//! - element_at_point: Identify element at screen coordinates
//! - frontmost_pid / pid_for_window: Process ID utilities
//! - raise_windows / resize_window_by_pid: Window management

use crate::platform::types::{AXNode, Rect, TextMatch};
use std::collections::HashMap;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker, TreeScope,
    TreeScope_Descendants, TreeScope_Element,
    UIA_ValueValuePropertyId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, SetForegroundWindow, ShowWindow, BringWindowToTop, SW_RESTORE,
    GetWindowThreadProcessId, EnumWindows, GetWindowRect, IsWindowVisible,
    GetWindowTextLengthW, SetWindowPos, HWND_TOP, SWP_NOACTIVATE,
};
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};

const MAX_DEPTH: u32 = 50;
const MAX_ELEMENTS: usize = 10_000;

// ──────────────────────────────────────────────────────────────────────────────
// AXRef — coordinate-based element reference (cross-thread safe)
// ──────────────────────────────────────────────────────────────────────────────

/// A retained reference to an accessibility element.
/// On Windows, stores the element's screen bounds (captured at snapshot time)
/// for coordinate-based action dispatch.
#[derive(Clone, Debug)]
pub struct AXRef {
    pub bounds: Option<Rect>,
    pub role: String,
    pub name: Option<String>,
}

// Safety: AXRef only stores plain data (Rect, String), inherently Send+Sync.
unsafe impl Send for AXRef {}
unsafe impl Sync for AXRef {}

impl AXRef {
    fn center(&self) -> Option<(f64, f64)> {
        self.bounds.as_ref().map(|b| (b.x + b.width / 2.0, b.y + b.height / 2.0))
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// take_snapshot — full UIA accessibility tree
// ──────────────────────────────────────────────────────────────────────────────

/// Collect the UIA accessibility tree for the given PID.
/// Returns (root_node, uid→AXRef map) matching the macOS take_snapshot signature.
pub fn take_snapshot(
    pid: i32,
    generation: u64,
) -> Result<(AXNode, HashMap<u32, AXRef>), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
            .map_err(|e| format!("Failed to create IUIAutomation: {e}"))?;

        // Find window for the PID
        let hwnd = find_hwnd_for_pid(pid as u32)
            .ok_or_else(|| format!("No visible window found for PID {pid}"))?;

        let root = automation
            .ElementFromHandle(hwnd)
            .map_err(|e| format!("Failed to get UIA element for PID {pid}: {e}"))?;

        let walker = automation
            .ControlViewWalker()
            .map_err(|e| format!("Failed to create ControlViewWalker: {e}"))?;

        let mut refs: HashMap<u32, AXRef> = HashMap::new();
        let mut uid_counter: u32 = 0;
        let mut element_count: usize = 0;

        let node = collect_uia_node(
            &walker,
            &root,
            &mut refs,
            &mut uid_counter,
            generation,
            &mut element_count,
            0,
        );

        Ok((node, refs))
    }
}

unsafe fn collect_uia_node(
    walker: &IUIAutomationTreeWalker,
    element: &IUIAutomationElement,
    refs: &mut HashMap<u32, AXRef>,
    counter: &mut u32,
    generation: u64,
    element_count: &mut usize,
    depth: u32,
) -> AXNode {
    if depth > MAX_DEPTH || *element_count >= MAX_ELEMENTS {
        let uid_n = *counter;
        *counter += 1;
        return AXNode {
            uid: format!("a{uid_n}g{generation}"),
            role: "truncated".into(),
            label: None, value: None, description: None,
            bounds: None, enabled: None, focused: None,
            children: vec![],
        };
    }

    *element_count += 1;
    let uid_n = *counter;
    *counter += 1;
    let uid = format!("a{uid_n}g{generation}");

    let role = element
        .CurrentControlType()
        .map(|ct| uia_control_type_name(ct.0))
        .unwrap_or_else(|_| "unknown".into());

    let label = element
        .CurrentName()
        .ok()
        .map(|n| n.to_string())
        .filter(|n| !n.is_empty());

    let value = element
        .GetCurrentPropertyValue(UIA_ValueValuePropertyId)
        .ok()
        .and_then(|v| {
            let s = v.to_string();
            if s.is_empty() { None } else { Some(s) }
        });

    let focused = element
        .CurrentHasKeyboardFocus()
        .map(|b| b.as_bool())
        .ok();

    let enabled = element
        .CurrentIsEnabled()
        .map(|b| b.as_bool())
        .ok();

    let bounds = element.CurrentBoundingRectangle().ok().and_then(|r| {
        let w = (r.right - r.left) as f64;
        let h = (r.bottom - r.top) as f64;
        if w > 0.0 && h > 0.0 {
            Some(Rect { x: r.left as f64, y: r.top as f64, width: w, height: h })
        } else {
            None
        }
    });

    // Store AXRef for action dispatch
    refs.insert(uid_n, AXRef {
        bounds: bounds.clone(),
        role: role.clone(),
        name: label.clone(),
    });

    // Collect children
    let mut children = Vec::new();
    if let Ok(child) = walker.GetFirstChildElement(element) {
        let mut current = child;
        loop {
            let child_node = collect_uia_node(
                walker, &current, refs, counter, generation, element_count, depth + 1,
            );
            children.push(child_node);
            match walker.GetNextSiblingElement(&current) {
                Ok(next) => current = next,
                Err(_) => break,
            }
        }
    }

    AXNode { uid, role, label, value, description: None, bounds, enabled, focused, children }
}

// ──────────────────────────────────────────────────────────────────────────────
// AX action dispatch (coordinate-based)
// ──────────────────────────────────────────────────────────────────────────────

pub fn ax_click(ax: &AXRef) -> Result<(), String> {
    let (x, y) = ax.center()
        .ok_or_else(|| "ax_click: element has no bounds for coordinate click".to_string())?;
    crate::platform::click(x, y, crate::platform::MouseButton::Left, 1)
        .map_err(|e| format!("ax_click coordinate click failed: {e}"))
}

pub fn ax_set_value(ax: &AXRef, value: &str) -> Result<(), String> {
    // Try UIA value pattern first, fall back to coordinate-based type_text
    if let Some((x, y)) = ax.center() {
        // Click to focus the element first
        let _ = crate::platform::click(x, y, crate::platform::MouseButton::Left, 1);
        std::thread::sleep(std::time::Duration::from_millis(50));
        // Select all and type new value
        let _ = crate::platform::press_key("a", &["ctrl".to_string()]);
        std::thread::sleep(std::time::Duration::from_millis(20));
        crate::platform::type_text(value)
            .map_err(|e| format!("ax_set_value type_text failed: {e}"))
    } else {
        Err("ax_set_value: element has no bounds".to_string())
    }
}

pub fn ax_select(ax: &AXRef) -> Result<(), String> {
    let (x, y) = ax.center()
        .ok_or_else(|| "ax_select: element has no bounds".to_string())?;
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
        "axfocus" | "focus" => {
            // Move mouse to element and click
            ax_click(ax)
        }
        _ => {
            // Default: left-click
            ax_click(ax)
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// ax_find_text — search UIA tree for text
// ──────────────────────────────────────────────────────────────────────────────

pub fn ax_find_text(search: &str, _window_id: Option<u32>) -> Result<Vec<TextMatch>, String> {
    let search_lower = search.to_lowercase();
    let mut matches = Vec::new();

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
            .map_err(|e| format!("Failed to create IUIAutomation: {e}"))?;

        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return Ok(Vec::new());
        }

        let root = automation
            .ElementFromHandle(hwnd)
            .map_err(|e| format!("Failed to get element for foreground window: {e}"))?;

        let condition = automation
            .CreateTrueCondition()
            .map_err(|e| format!("Failed to create condition: {e}"))?;

        let scope = TreeScope(TreeScope_Element.0 | TreeScope_Descendants.0);
        let elements = root
            .FindAll(scope, &condition)
            .map_err(|e| format!("FindAll failed: {e}"))?;

        let count = elements.Length()
            .map_err(|e| format!("Element count failed: {e}"))?;

        let mut seen: std::collections::HashSet<(i32, i32)> = std::collections::HashSet::new();

        for i in 0..count {
            let elem = match elements.GetElement(i) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let rect = match elem.CurrentBoundingRectangle() {
                Ok(r) => r,
                Err(_) => continue,
            };

            let w = (rect.right - rect.left) as f64;
            let h = (rect.bottom - rect.top) as f64;
            if w <= 0.0 || h <= 0.0 { continue; }

            // Check name, value, and help text
            let name = elem.CurrentName().ok().map(|n| n.to_string()).filter(|n| !n.is_empty());
            let value = elem.GetCurrentPropertyValue(UIA_ValueValuePropertyId)
                .ok()
                .and_then(|v| { let s = v.to_string(); if s.is_empty() { None } else { Some(s) } });
            let help = elem.CurrentHelpText().ok().map(|h| h.to_string()).filter(|h| !h.is_empty());

            let matched = [name.as_deref(), value.as_deref(), help.as_deref()]
                .iter()
                .flatten()
                .find(|t| t.to_lowercase().contains(&search_lower))
                .map(|s| s.to_string());

            let text = match matched { Some(t) => t, None => continue };

            let cx = rect.left as f64 + w / 2.0;
            let cy = rect.top as f64 + h / 2.0;
            let key = ((cx / 2.0) as i32, (cy / 2.0) as i32);
            if !seen.insert(key) { continue; }

            let role = elem.CurrentControlType().ok()
                .map(|ct| uia_control_type_name(ct.0));

            matches.push(TextMatch {
                text,
                x: cx,
                y: cy,
                confidence: 1.0,
                bounds: Rect { x: rect.left as f64, y: rect.top as f64, width: w, height: h },
                role,
            });
        }
    }

    Ok(matches)
}

// ──────────────────────────────────────────────────────────────────────────────
// ax_find_elements — targeted search (much smaller than full snapshot)
// ──────────────────────────────────────────────────────────────────────────────

/// Walk the foreground window's UIA tree and return elements matching
/// `text_query` (name/value/help, case-insensitive) and/or `role_filter`.
/// Only matching nodes are returned (no children), each with a UID registered
/// in `refs` for subsequent ax_click / ax_set_value calls.
pub fn ax_find_elements(
    pid: i32,
    text_query: Option<&str>,
    role_filter: Option<&str>,
    max_results: usize,
    generation: u64,
) -> Result<(Vec<AXNode>, HashMap<u32, AXRef>), String> {
    let text_lower = text_query.map(|s| s.to_lowercase());
    let role_lower = role_filter.map(|s| s.to_lowercase());
    let mut nodes: Vec<AXNode> = Vec::new();
    let mut refs:  HashMap<u32, AXRef> = HashMap::new();
    let mut uid_counter: u32 = 0;

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
            .map_err(|e| format!("Failed to create IUIAutomation: {e}"))?;

        let hwnd = if pid > 0 {
            find_hwnd_for_pid(pid as u32)
                .ok_or_else(|| format!("No visible window found for PID {pid}"))?
        } else {
            let h = GetForegroundWindow();
            if h.0.is_null() { return Err("No foreground window".into()); }
            h
        };

        let root = automation
            .ElementFromHandle(hwnd)
            .map_err(|e| format!("Failed to get root element: {e}"))?;

        let condition = automation
            .CreateTrueCondition()
            .map_err(|e| format!("Failed to create condition: {e}"))?;

        let scope = TreeScope(TreeScope_Element.0 | TreeScope_Descendants.0);
        let elements = root
            .FindAll(scope, &condition)
            .map_err(|e| format!("FindAll failed: {e}"))?;

        let count = elements.Length().unwrap_or(0);

        for i in 0..count {
            if nodes.len() >= max_results { break; }

            let elem = match elements.GetElement(i) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let role = elem.CurrentControlType().ok()
                .map(|ct| uia_control_type_name(ct.0))
                .unwrap_or_else(|| "unknown".into());

            // Role filter
            if let Some(rf) = &role_lower {
                if !role.to_lowercase().contains(rf.as_str()) { continue; }
            }

            let name = elem.CurrentName().ok().map(|n| n.to_string()).filter(|n| !n.is_empty());
            let value = elem.GetCurrentPropertyValue(UIA_ValueValuePropertyId)
                .ok()
                .and_then(|v| { let s = v.to_string(); if s.is_empty() { None } else { Some(s) } });
            let help = elem.CurrentHelpText().ok().map(|h| h.to_string()).filter(|h| !h.is_empty());

            // Text filter
            if let Some(tq) = &text_lower {
                let hit = [name.as_deref(), value.as_deref(), help.as_deref()]
                    .iter()
                    .flatten()
                    .any(|t| t.to_lowercase().contains(tq.as_str()));
                if !hit { continue; }
            } else if role_lower.is_none() {
                // No filters: only include interactive elements
                let interactive = matches!(
                    role.as_str(),
                    "Button" | "Edit" | "CheckBox" | "RadioButton" | "ComboBox"
                    | "Slider" | "Hyperlink" | "MenuItem" | "TabItem" | "Text"
                );
                if !interactive { continue; }
            }

            let rect = elem.CurrentBoundingRectangle().ok();
            let bounds = rect.and_then(|r| {
                let w = (r.right - r.left) as f64;
                let h = (r.bottom - r.top) as f64;
                if w > 0.0 && h > 0.0 {
                    Some(Rect { x: r.left as f64, y: r.top as f64, width: w, height: h })
                } else { None }
            });

            let focused = elem.CurrentHasKeyboardFocus().map(|b| b.as_bool()).ok();
            let enabled = elem.CurrentIsEnabled().map(|b| b.as_bool()).ok();

            let uid_n = uid_counter;
            uid_counter += 1;

            refs.insert(uid_n, AXRef {
                bounds: bounds.clone(),
                role: role.clone(),
                name: name.clone(),
            });

            nodes.push(AXNode {
                uid: format!("a{uid_n}g{generation}"),
                role,
                label: name,
                value,
                description: help,
                bounds,
                enabled,
                focused,
                children: vec![],
            });
        }
    }

    Ok((nodes, refs))
}

// ──────────────────────────────────────────────────────────────────────────────
// ax_get_focused — cheapest AX query: get the currently focused element
// ──────────────────────────────────────────────────────────────────────────────

/// Return the system-wide focused UIA element as a single slim AXNode.
/// Returns `None` when no element is focused.
pub fn ax_get_focused(
    generation: u64,
) -> Result<Option<(AXNode, HashMap<u32, AXRef>)>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
            .map_err(|e| format!("Failed to create IUIAutomation: {e}"))?;

        let elem = match automation.GetFocusedElement() {
            Ok(e) => e,
            Err(_) => return Ok(None),
        };

        let role = elem.CurrentControlType().ok()
            .map(|ct| uia_control_type_name(ct.0))
            .unwrap_or_else(|| "unknown".into());

        let label = elem.CurrentName().ok().map(|n| n.to_string()).filter(|n| !n.is_empty());
        let value = elem.GetCurrentPropertyValue(UIA_ValueValuePropertyId)
            .ok()
            .and_then(|v| { let s = v.to_string(); if s.is_empty() { None } else { Some(s) } });
        let description = elem.CurrentHelpText().ok().map(|h| h.to_string()).filter(|h| !h.is_empty());

        let bounds = elem.CurrentBoundingRectangle().ok().and_then(|r| {
            let w = (r.right - r.left) as f64;
            let h = (r.bottom - r.top) as f64;
            if w > 0.0 && h > 0.0 {
                Some(Rect { x: r.left as f64, y: r.top as f64, width: w, height: h })
            } else { None }
        });

        let enabled = elem.CurrentIsEnabled().map(|b| b.as_bool()).ok();

        let mut refs: HashMap<u32, AXRef> = HashMap::new();
        refs.insert(0, AXRef { bounds: bounds.clone(), role: role.clone(), name: label.clone() });

        let node = AXNode {
            uid: format!("a0g{generation}"),
            role,
            label,
            value,
            description,
            bounds,
            enabled,
            focused: Some(true),
            children: vec![],
        };

        Ok(Some((node, refs)))
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// element_at_point
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
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
            .map_err(|e| format!("Failed to create IUIAutomation: {e}"))?;

        let point = windows::Win32::Foundation::POINT { x: x as i32, y: y as i32 };
        let elem = automation
            .ElementFromPoint(point)
            .map_err(|e| format!("No element at ({x},{y}): {e}"))?;

        let name = elem.CurrentName().ok().map(|n| n.to_string()).filter(|n| !n.is_empty());
        let role = elem.CurrentControlType().ok().map(|ct| uia_control_type_name(ct.0));
        let value = elem.GetCurrentPropertyValue(UIA_ValueValuePropertyId)
            .ok()
            .and_then(|v| { let s = v.to_string(); if s.is_empty() { None } else { Some(s) } });
        let description = elem.CurrentHelpText().ok().map(|h| h.to_string()).filter(|h| !h.is_empty());
        let pid = elem.CurrentProcessId().unwrap_or(0) as i32;

        let bounds = elem.CurrentBoundingRectangle().ok().and_then(|r| {
            let w = (r.right - r.left) as f64;
            let h = (r.bottom - r.top) as f64;
            if w > 0.0 && h > 0.0 {
                Some(Rect { x: r.left as f64, y: r.top as f64, width: w, height: h })
            } else { None }
        });

        let app_name = get_process_name(pid as u32);

        Ok(ElementInfo { name, role, value, description, bounds, pid, app_name })
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Window / process utilities
// ──────────────────────────────────────────────────────────────────────────────

pub fn frontmost_pid() -> Result<i32, String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return Err("No foreground window".to_string());
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        Ok(pid as i32)
    }
}

pub fn pid_for_window(window_id: u32) -> Result<i32, String> {
    let hwnd = HWND(window_id as isize as *mut _);
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
    if pid == 0 {
        Err(format!("Window {window_id} not found"))
    } else {
        Ok(pid as i32)
    }
}

pub fn raise_windows(pid: i32) -> Result<(), String> {
    // Find all windows belonging to the PID and bring the first to foreground
    let hwnd = find_hwnd_for_pid(pid as u32)
        .ok_or_else(|| format!("No window for PID {pid}"))?;

    unsafe {
        // Restore if minimized
        if ShowWindow(hwnd, SW_RESTORE).0 == 0 {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = BringWindowToTop(hwnd);

        // Attach input threads to force foreground
        let fg_hwnd = GetForegroundWindow();
        if fg_hwnd != hwnd {
            let fg_tid = GetWindowThreadProcessId(fg_hwnd, None);
            let cur_tid = GetCurrentThreadId();
            let _ = AttachThreadInput(fg_tid, cur_tid, true);
            let _ = SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(fg_tid, cur_tid, false);
        } else {
            let _ = SetForegroundWindow(hwnd);
        }
    }
    Ok(())
}

pub fn resize_window_by_pid(
    pid: i32,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let hwnd = find_hwnd_for_pid(pid as u32)
        .ok_or_else(|| format!("No window for PID {pid}"))?;

    unsafe {
        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);

        let nx = x.unwrap_or(rect.left as f64) as i32;
        let ny = y.unwrap_or(rect.top as f64) as i32;
        let nw = width.unwrap_or((rect.right - rect.left) as f64) as i32;
        let nh = height.unwrap_or((rect.bottom - rect.top) as f64) as i32;

        SetWindowPos(hwnd, HWND_TOP, nx, ny, nw, nh, SWP_NOACTIVATE)
            .map_err(|e| format!("SetWindowPos failed: {e}"))?;
    }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Find the first visible top-level window for a given PID.
pub(crate) fn find_hwnd_for_pid(target_pid: u32) -> Option<HWND> {
    struct FindData { pid: u32, result: Option<HWND> }

    unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let data = &mut *(lparam.0 as *mut FindData);
        if IsWindowVisible(hwnd).as_bool() {
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == data.pid {
                let title_len = GetWindowTextLengthW(hwnd);
                if title_len > 0 {
                    if data.result.is_none() {
                        data.result = Some(hwnd);
                    }
                }
            }
        }
        TRUE
    }

    let mut data = FindData { pid: target_pid, result: None };
    unsafe { let _ = EnumWindows(Some(callback), LPARAM(&mut data as *mut _ as isize)); }
    data.result
}

pub(crate) fn get_process_name(pid: u32) -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::core::PWSTR;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::Foundation::CloseHandle;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf: Vec<u16> = vec![0; 260];
        let mut size = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if result.is_ok() && size > 0 {
            let path = OsString::from_wide(&buf[..size as usize])
                .to_string_lossy()
                .into_owned();
            path.rsplit('\\')
                .next()
                .map(|s| s.strip_suffix(".exe").unwrap_or(s).to_string())
        } else {
            None
        }
    }
}

/// Map UIA ControlTypeId to a role string.
fn uia_control_type_name(id: i32) -> String {
    match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        _ => "Unknown",
    }
    .to_string()
}

/// Public alias for find_hwnd_for_pid.
pub fn find_window_for_pid(pid: u32) -> Option<HWND> {
    find_hwnd_for_pid(pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_uia_control_type_name_known() {
        assert_eq!(uia_control_type_name(50000), "Button");
        assert_eq!(uia_control_type_name(50032), "Window");
    }

    #[test]
    fn test_uia_control_type_name_unknown() {
        assert_eq!(uia_control_type_name(99999), "Unknown");
    }
}
