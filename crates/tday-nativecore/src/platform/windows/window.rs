// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Windows window enumeration.

use crate::platform::types::{Rect, WindowInfo};
use std::ffi::OsString;
use std::mem;
use std::os::windows::ffi::OsStringExt;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
};

struct WinEnumData {
    windows: Vec<WindowInfo>,
}

/// List all visible top-level windows.
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let mut data = WinEnumData { windows: Vec::new() };
    unsafe {
        EnumWindows(Some(window_enum_callback), LPARAM(&mut data as *mut _ as isize))
            .map_err(|e| format!("EnumWindows failed: {e}"))?;
    }
    Ok(data.windows)
}

unsafe extern "system" fn window_enum_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let data = &mut *(lparam.0 as *mut WinEnumData);

    if !IsWindowVisible(hwnd).as_bool() { return TRUE; }

    let title_len = GetWindowTextLengthW(hwnd);
    if title_len == 0 { return TRUE; }

    // Skip owned windows (popups, tooltips)
    if let Ok(owner) = GetWindow(hwnd, GW_OWNER) {
        if !owner.is_invalid() { return TRUE; }
    }

    let mut title_buf: Vec<u16> = vec![0; (title_len + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut title_buf);
    let name = if copied > 0 {
        Some(OsString::from_wide(&title_buf[..copied as usize]).to_string_lossy().into_owned())
    } else {
        None
    };

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));

    let owner_name = super::uia::get_process_name(pid).unwrap_or_default();

    let bounds = get_window_bounds(hwnd);

    data.windows.push(WindowInfo {
        id: hwnd.0 as usize as u32,
        name,
        owner_name,
        owner_pid: pid as i64,
        bounds,
        layer: 0,
        is_on_screen: true,
    });

    TRUE
}

fn get_window_bounds(hwnd: HWND) -> Rect {
    let mut rect = RECT::default();
    let dwm_ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            mem::size_of::<RECT>() as u32,
        ).is_ok()
    };
    if !dwm_ok {
        unsafe { let _ = GetWindowRect(hwnd, &mut rect); }
    }
    Rect {
        x: rect.left as f64,
        y: rect.top as f64,
        width: (rect.right - rect.left) as f64,
        height: (rect.bottom - rect.top) as f64,
    }
}

/// Find a window by its HWND (as u32 ID).
pub fn find_window_by_id_direct(window_id: u32) -> Result<Option<WindowInfo>, String> {
    let hwnd = HWND(window_id as isize as *mut _);
    if unsafe { !IsWindowVisible(hwnd).as_bool() } {
        return Ok(None);
    }
    let bounds = get_window_bounds(hwnd);
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
    let owner_name = super::uia::get_process_name(pid).unwrap_or_default();
    Ok(Some(WindowInfo {
        id: window_id,
        name: None,
        owner_name,
        owner_pid: pid as i64,
        bounds,
        layer: 0,
        is_on_screen: true,
    }))
}

/// Find all windows belonging to an app (case-insensitive substring match on owner_name).
pub fn find_windows_by_app(app_name: &str) -> Result<Vec<WindowInfo>, String> {
    let needle = app_name.to_lowercase();
    Ok(list_windows()?
        .into_iter()
        .filter(|w| w.owner_name.to_lowercase().contains(&needle))
        .collect())
}
