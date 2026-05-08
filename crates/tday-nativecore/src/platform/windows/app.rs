// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Windows app lifecycle utilities.
//!
//! Implements list_apps, launch_app, quit_app, activate_app, etc.

use crate::platform::types::AppInfo;
use std::collections::HashMap;
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, TRUE};
use windows::Win32::System::ProcessStatus::EnumProcesses;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
};

// ──────────────────────────────────────────────────────────────────────────────
// list_apps
// ──────────────────────────────────────────────────────────────────────────────

/// Returns a snapshot of all running user processes.
pub fn list_apps() -> Vec<AppInfo> {
    let foreground_pid = crate::platform::frontmost_pid().unwrap_or(-1);

    let mut pids = vec![0u32; 4096];
    let mut bytes_returned: u32 = 0;
    unsafe {
        if EnumProcesses(
            pids.as_mut_ptr(),
            (pids.len() * std::mem::size_of::<u32>()) as u32,
            &mut bytes_returned,
        )
        .is_err()
        {
            return Vec::new();
        }
    }
    let count = bytes_returned as usize / std::mem::size_of::<u32>();
    pids.truncate(count);

    // Collect PIDs with visible windows
    let window_pids = collect_window_pids();

    pids.iter()
        .filter_map(|&pid| {
            if pid == 0 { return None; }
            let name = get_process_exe_name(pid)?;
            Some(AppInfo {
                name,
                bundle_id: None,
                pid: pid as i32,
                is_active: pid as i32 == foreground_pid,
                is_hidden: !window_pids.contains(&pid),
                is_user_app: window_pids.contains(&pid),
            })
        })
        .collect()
}

fn collect_window_pids() -> std::collections::HashSet<u32> {
    let mut pids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    struct State(std::collections::HashSet<u32>);
    let mut state = State(std::collections::HashSet::new());
    unsafe {
        let _ = EnumWindows(
            Some(window_pid_callback),
            LPARAM(&mut state as *mut State as isize),
        );
    }
    state.0
}

unsafe extern "system" fn window_pid_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let set = &mut *(lparam.0 as *mut std::collections::HashSet<u32>);
    if IsWindowVisible(hwnd).as_bool() {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 {
            set.insert(pid);
        }
    }
    TRUE
}

fn get_process_exe_name(pid: u32) -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::core::PWSTR;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf: Vec<u16> = vec![0u16; 260];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if ok.is_ok() && size > 0 {
            let path = OsString::from_wide(&buf[..size as usize])
                .to_string_lossy()
                .into_owned();
            path.rsplit('\\').next().map(|s| s.to_string())
        } else {
            None
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// find_app_pid
// ──────────────────────────────────────────────────────────────────────────────

/// Find the PID of the first process whose exe name matches `app_name` (case-insensitive).
pub fn find_app_pid(app_name: &str) -> Option<i32> {
    let needle = app_name.to_lowercase();
    list_apps()
        .into_iter()
        .find(|a| a.name.to_lowercase().contains(&needle) || {
            a.name.to_lowercase().trim_end_matches(".exe").contains(&needle)
        })
        .map(|a| a.pid)
}

/// Check whether any process with `app_name` is running.
pub fn is_running(app_name: &str) -> bool {
    find_app_pid(app_name).is_some()
}

// ──────────────────────────────────────────────────────────────────────────────
// activate_by_pid
// ──────────────────────────────────────────────────────────────────────────────

/// Bring the first window of the given PID to the foreground.
pub fn activate_by_pid(pid: i32) -> bool {
    super::uia::raise_windows(pid).is_ok()
}

// ──────────────────────────────────────────────────────────────────────────────
// activate_app
// ──────────────────────────────────────────────────────────────────────────────

/// Activate an app by name.
pub fn activate_app(app_name: &str) -> bool {
    if let Some(pid) = find_app_pid(app_name) {
        return activate_by_pid(pid);
    }
    false
}

// ──────────────────────────────────────────────────────────────────────────────
// launch_app
// ──────────────────────────────────────────────────────────────────────────────

/// Launch an application. Uses `cmd /c start "" app_name` for GUI apps,
/// or `std::process::Command` for executables with a full path.
pub fn launch_app(
    app_name: &str,
    args: &[String],
    background: bool,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/c", "start", "", app_name]);
    for a in args {
        cmd.arg(a);
    }
    if background {
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("launch_app (background) failed: {e}"))
    } else {
        let status = cmd
            .status()
            .map_err(|e| format!("launch_app failed: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("launch_app: cmd /c start exited with {:?}", status.code()))
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// quit_app
// ──────────────────────────────────────────────────────────────────────────────

/// Kill all processes matching `app_name`. Returns the number of processes killed.
pub fn quit_app(app_name: &str, _force: bool) -> Result<usize, String> {
    let needle = app_name.to_lowercase();
    let apps = list_apps();
    let mut killed = 0;
    for a in &apps {
        let name_lower = a.name.to_lowercase();
        if name_lower.contains(&needle) || name_lower.trim_end_matches(".exe").contains(&needle) {
            unsafe {
                if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, a.pid as u32) {
                    let _ = TerminateProcess(handle, 1);
                    let _ = CloseHandle(handle);
                    killed += 1;
                }
            }
        }
    }
    Ok(killed)
}

// ──────────────────────────────────────────────────────────────────────────────
// resize_window
// ──────────────────────────────────────────────────────────────────────────────

/// Resize/reposition the first window of `app_name`.
pub fn resize_window(
    app_name: &str,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let pid = find_app_pid(app_name)
        .ok_or_else(|| format!("App not found: {app_name}"))?;
    super::uia::resize_window_by_pid(pid, x, y, width, height)
}

// ──────────────────────────────────────────────────────────────────────────────
// Browser / Electron detection
// ──────────────────────────────────────────────────────────────────────────────

/// On Windows, we identify Chrome-family browsers by exe name.
pub fn is_chrome_browser(_bundle_id: Option<&str>, app_name: &str) -> bool {
    let lower = app_name.to_lowercase();
    lower.contains("chrome") || lower.contains("msedge") || lower.contains("chromium")
        || lower.contains("brave") || lower.contains("opera") || lower.contains("vivaldi")
}

/// Check if a PID is an Electron app by detecting electron.exe or app.asar.
pub fn is_electron_app_by_pid(pid: i32) -> bool {
    if let Some(name) = get_process_exe_name(pid as u32) {
        if is_electron_app_by_name(&name) { return true; }
    }
    // Check for app.asar path in process module
    if let Some(full_path) = get_process_full_path(pid as u32) {
        let parent = std::path::Path::new(&full_path)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("");
        return parent.contains("electron") || full_path.contains("app.asar");
    }
    false
}

/// Check if an app name looks like an Electron app.
pub fn is_electron_app_by_name(app_name: &str) -> bool {
    let lower = app_name.to_lowercase();
    lower.contains("electron")
        || lower.ends_with("app.exe") // common electron pattern
        || lower == "code.exe"        // VS Code
        || lower == "slack.exe"
        || lower == "discord.exe"
        || lower == "notion.exe"
        || lower == "figma.exe"
}

fn get_process_full_path(pid: u32) -> Option<String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows::core::PWSTR;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf: Vec<u16> = vec![0u16; 32768];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if ok.is_ok() && size > 0 {
            Some(OsString::from_wide(&buf[..size as usize]).to_string_lossy().into_owned())
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_apps_non_empty() {
        let apps = list_apps();
        assert!(!apps.is_empty(), "should have some processes");
    }

    #[test]
    fn test_is_running_system_process() {
        // "explorer" should virtually always be running on Windows
        // This is a best-effort check; may not be true in headless CI
        let _ = is_running("explorer");
    }

    #[test]
    fn test_is_electron_by_name() {
        assert!(is_electron_app_by_name("code.exe"));
        assert!(is_electron_app_by_name("slack.exe"));
        assert!(!is_electron_app_by_name("notepad.exe"));
    }

    #[test]
    fn test_is_chrome_browser() {
        assert!(is_chrome_browser(None, "chrome.exe"));
        assert!(!is_chrome_browser(None, "notepad.exe"));
    }
}
