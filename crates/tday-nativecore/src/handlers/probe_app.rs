// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

//! Probe app handler — classify a running or installed app as Native/ElectronApp/ChromeBrowser.

use rmcp::model::{CallToolResult, Content};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AppKind {
    Native,
    ElectronApp,
    ChromeBrowser,
}

#[derive(Debug, Serialize)]
pub struct ProbeAppResult {
    pub name: String,
    pub kind: AppKind,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn classify_running(pid: i32, bundle_id: Option<&str>, app_name: &str) -> AppKind {
    if crate::platform::is_chrome_browser(bundle_id, app_name) {
        return AppKind::ChromeBrowser;
    }
    if crate::platform::is_electron_app_by_pid(pid) {
        return AppKind::ElectronApp;
    }
    AppKind::Native
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn classify_installed(app_name: &str) -> AppKind {
    if crate::platform::is_electron_app_by_name(app_name) {
        return AppKind::ElectronApp;
    }
    AppKind::Native
}

pub fn probe_app(app_name: &str) -> CallToolResult {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let apps = crate::platform::list_apps();
        let needle = app_name.to_lowercase();
        let running_app = apps
            .iter()
            .find(|a| a.name.to_lowercase() == needle)
            .or_else(|| apps.iter().find(|a| a.name.to_lowercase().contains(&needle)));

        let result = if let Some(app) = running_app {
            let kind = classify_running(app.pid, app.bundle_id.as_deref(), &app.name);
            ProbeAppResult {
                name: app.name.clone(),
                kind,
                running: true,
                pid: Some(app.pid),
                bundle_id: app.bundle_id.clone(),
            }
        } else {
            let kind = classify_installed(app_name);
            ProbeAppResult {
                name: app_name.to_string(),
                kind,
                running: false,
                pid: None,
                bundle_id: None,
            }
        };

        CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&result).unwrap_or_else(|e| format!("Serialize error: {e}")),
        )])
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        CallToolResult::error(vec![Content::text(
            "probe_app is not supported on this platform",
        )])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_kind_serializes_correctly() {
        assert_eq!(serde_json::to_string(&AppKind::Native).unwrap(), "\"Native\"");
        assert_eq!(serde_json::to_string(&AppKind::ElectronApp).unwrap(), "\"ElectronApp\"");
        assert_eq!(serde_json::to_string(&AppKind::ChromeBrowser).unwrap(), "\"ChromeBrowser\"");
    }

    #[test]
    fn result_omits_none_fields() {
        let result = ProbeAppResult {
            name: "Safari".to_string(),
            kind: AppKind::Native,
            running: false,
            pid: None,
            bundle_id: None,
        };
        let json: serde_json::Value = serde_json::to_value(&result).unwrap();
        assert!(!json.as_object().unwrap().contains_key("pid"));
        assert!(!json.as_object().unwrap().contains_key("bundle_id"));
    }
}
