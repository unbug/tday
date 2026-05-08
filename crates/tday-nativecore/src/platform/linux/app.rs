// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Linux app management using /proc, ps, and subprocess tools.

use crate::platform::types::AppInfo;

/// List running apps. Uses /proc or `ps` to enumerate processes.
pub fn list_apps() -> Vec<AppInfo> {
    let active_pid = super::atspi::frontmost_pid().unwrap_or(-1);
    let window_pids = get_window_pids();

    // Read from /proc
    let mut apps = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if let Ok(pid) = name_str.parse::<u32>() {
                if let Some(exe_name) = get_process_name(pid) {
                    apps.push(AppInfo {
                        name: exe_name,
                        bundle_id: None,
                        pid: pid as i32,
                        is_active: pid as i32 == active_pid,
                        is_hidden: !window_pids.contains(&pid),
                        is_user_app: window_pids.contains(&pid),
                    });
                }
            }
        }
    }
    apps
}

fn get_window_pids() -> std::collections::HashSet<u32> {
    let mut set = std::collections::HashSet::new();
    // Use wmctrl -lp to get PIDs of windows
    if let Ok(out) = std::process::Command::new("wmctrl")
        .args(["-l", "-p"])
        .output()
    {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                if let Ok(pid) = parts[2].parse::<u32>() {
                    set.insert(pid);
                }
            }
        }
    }
    set
}

fn get_process_name(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn get_process_exe(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
}

pub fn find_app_pid(app_name: &str) -> Option<i32> {
    let needle = app_name.to_lowercase();
    list_apps()
        .into_iter()
        .find(|a| a.name.to_lowercase().contains(&needle))
        .map(|a| a.pid)
}

pub fn is_running(app_name: &str) -> bool {
    find_app_pid(app_name).is_some()
}

pub fn activate_by_pid(pid: i32) -> bool {
    // Use wmctrl to raise the first window belonging to this PID
    if let Ok(out) = std::process::Command::new("wmctrl")
        .args(["-l", "-p"])
        .output()
    {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                if parts[2].parse::<i32>().unwrap_or(-1) == pid {
                    let id = parts[0];
                    let ok = std::process::Command::new("wmctrl")
                        .args(["-ia", id])
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);
                    if ok { return true; }
                }
            }
        }
    }
    // Fallback: xdotool
    std::process::Command::new("xdotool")
        .args(["search", "--pid", &pid.to_string(), "windowactivate"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn activate_app(app_name: &str) -> bool {
    if let Some(pid) = find_app_pid(app_name) {
        return activate_by_pid(pid);
    }
    // Fallback: wmctrl by name
    std::process::Command::new("wmctrl")
        .args(["-a", app_name])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn launch_app(app_name: &str, args: &[String], background: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new("xdg-open");
    if !args.is_empty() || !app_name.ends_with(".desktop") {
        // Direct binary launch
        cmd = std::process::Command::new(app_name);
        for a in args { cmd.arg(a); }
    } else {
        cmd.arg(app_name);
    }

    if background {
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| format!("launch_app failed: {e}"))
    } else {
        let status = cmd.status().map_err(|e| format!("launch_app failed: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("launch_app exited with {:?}", status.code()))
        }
    }
}

pub fn quit_app(app_name: &str, force: bool) -> Result<usize, String> {
    let needle = app_name.to_lowercase();
    let apps = list_apps();
    let mut killed = 0;
    for a in &apps {
        if a.name.to_lowercase().contains(&needle) {
            let sig = if force { "KILL" } else { "TERM" };
            let ok = std::process::Command::new("kill")
                .args([format!("-{sig}"), a.pid.to_string()])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if ok { killed += 1; }
        }
    }
    Ok(killed)
}

pub fn resize_window(
    app_name: &str,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    // wmctrl -r <name> -e <gravity,x,y,w,h>
    let xi = x.map(|v| v as i32).unwrap_or(-1);
    let yi = y.map(|v| v as i32).unwrap_or(-1);
    let wi = width.map(|v| v as i32).unwrap_or(-1);
    let hi = height.map(|v| v as i32).unwrap_or(-1);

    let geometry = format!("0,{xi},{yi},{wi},{hi}");
    let ok = std::process::Command::new("wmctrl")
        .args(["-r", app_name, "-e", &geometry])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if ok {
        Ok(())
    } else {
        Err(format!("wmctrl resize failed for '{app_name}'"))
    }
}

pub fn is_chrome_browser(_bundle_id: Option<&str>, app_name: &str) -> bool {
    let lower = app_name.to_lowercase();
    lower.contains("chrome") || lower.contains("chromium")
        || lower.contains("google-chrome") || lower.contains("msedge")
        || lower.contains("brave") || lower.contains("opera")
}

pub fn is_electron_app_by_pid(pid: i32) -> bool {
    if let Some(exe) = get_process_exe(pid as u32) {
        if is_electron_app_by_name(&exe) { return true; }
    }
    // Check for app.asar in /proc/<pid>/maps
    if let Ok(maps) = std::fs::read_to_string(format!("/proc/{pid}/maps")) {
        return maps.contains("app.asar") || maps.contains("/electron");
    }
    false
}

pub fn is_electron_app_by_name(app_name: &str) -> bool {
    let lower = app_name.to_lowercase();
    lower.contains("electron")
        || lower == "code"
        || lower == "slack"
        || lower == "discord"
        || lower == "notion"
        || lower == "figma"
}
