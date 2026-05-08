// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Linux window enumeration via wmctrl subprocess.

use crate::platform::types::{Rect, WindowInfo};

/// List all windows using wmctrl.
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    // wmctrl -l -G: win_id  desktop  x  y  w  h  hostname  title
    let out = std::process::Command::new("wmctrl")
        .args(["-l", "-G"])
        .output()
        .map_err(|e| format!("wmctrl not found (install wmctrl): {e}"))?;

    if !out.status.success() {
        return Err(format!("wmctrl exited with: {:?}", out.status.code()));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut windows = Vec::new();

    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(9, char::is_whitespace)
            .filter(|s| !s.is_empty())
            .collect();
        if parts.len() < 8 { continue; }

        let id_hex = parts[0].trim_start_matches("0x");
        let id = u32::from_str_radix(id_hex, 16).unwrap_or(0);
        let x = parts[2].parse::<f64>().unwrap_or(0.0);
        let y = parts[3].parse::<f64>().unwrap_or(0.0);
        let w = parts[4].parse::<f64>().unwrap_or(0.0);
        let h = parts[5].parse::<f64>().unwrap_or(0.0);
        let title = if parts.len() >= 8 {
            // Skip hostname (parts[6])
            Some(parts[7..].join(" "))
        } else {
            None
        };

        windows.push(WindowInfo {
            id,
            name: title,
            owner_name: String::new(),
            owner_pid: 0,
            bounds: Rect { x, y, width: w, height: h },
            layer: 0,
            is_on_screen: true,
        });
    }

    // Try to fill in owner_name / owner_pid via wmctrl -lp
    if let Ok(lp) = wmctrl_lp() {
        for win in &mut windows {
            if let Some(&pid) = lp.get(&win.id) {
                win.owner_pid = pid as i64;
                if let Some(name) = get_process_name(pid) {
                    win.owner_name = name;
                }
            }
        }
    }

    Ok(windows)
}

fn wmctrl_lp() -> Result<std::collections::HashMap<u32, u32>, String> {
    let out = std::process::Command::new("wmctrl")
        .args(["-l", "-p"])
        .output()
        .map_err(|e| e.to_string())?;

    let mut map = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 {
            let id_hex = parts[0].trim_start_matches("0x");
            let id = u32::from_str_radix(id_hex, 16).unwrap_or(0);
            let pid = parts[2].parse::<u32>().unwrap_or(0);
            map.insert(id, pid);
        }
    }
    Ok(map)
}

pub fn find_window_by_id_direct(window_id: u32) -> Result<Option<WindowInfo>, String> {
    Ok(list_windows()?.into_iter().find(|w| w.id == window_id))
}

pub fn find_windows_by_app(app_name: &str) -> Result<Vec<WindowInfo>, String> {
    let needle = app_name.to_lowercase();
    Ok(list_windows()?
        .into_iter()
        .filter(|w| {
            w.owner_name.to_lowercase().contains(&needle)
                || w.name.as_deref().unwrap_or("").to_lowercase().contains(&needle)
        })
        .collect())
}

fn get_process_name(pid: u32) -> Option<String> {
    std::fs::read_to_string(format!("/proc/{pid}/comm"))
        .ok()
        .map(|s| s.trim().to_string())
}
