// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

//! ADB device management — list, connect, run shell commands, framebuffer.

use adb_client::ADBDeviceExt;
use adb_client::server::ADBServer;
use adb_client::server_device::ADBServerDevice;
use serde::Serialize;

/// Basic info about a connected ADB device.
#[derive(Debug, Clone, Serialize)]
pub struct AndroidDeviceInfo {
    pub serial: String,
    pub state: String,
}

/// A connected ADB device session. Holds the underlying `ADBServerDevice`.
pub struct AndroidDevice {
    #[allow(dead_code)]
    pub serial: String,
    device: ADBServerDevice,
}

/// List all devices visible to the local ADB server.
pub fn list_devices() -> Result<Vec<AndroidDeviceInfo>, String> {
    let mut server = ADBServer::default();
    let devices = server
        .devices()
        .map_err(|e| format!("Failed to list ADB devices: {e}"))?;

    Ok(devices
        .into_iter()
        .map(|d| AndroidDeviceInfo {
            serial: d.identifier,
            state: d.state.to_string(),
        })
        .collect())
}

impl AndroidDevice {
    /// Connect to a specific device by serial number.
    pub fn connect(serial: &str) -> Result<Self, String> {
        let mut server = ADBServer::default();
        let device = server
            .get_device_by_name(serial)
            .map_err(|e| format!("Failed to connect to device '{serial}': {e}"))?;
        Ok(Self { serial: serial.to_string(), device })
    }

    /// Run a shell command string, returning UTF-8 stdout.
    pub fn shell(&mut self, command: &str) -> Result<String, String> {
        let mut output = Vec::new();
        self.device
            .shell_command(&command, Some(&mut output), None)
            .map_err(|e| format!("Shell command failed: {e}"))?;
        String::from_utf8(output).map_err(|e| format!("Shell output is not valid UTF-8: {e}"))
    }

    /// Run a shell command from a slice of argument strings.
    ///
    /// Each argument is shell-quoted using POSIX single-quote wrapping so that
    /// metacharacters (`;`, `&`, `|`, `$`, newline, etc.) are never interpreted
    /// by the Android device shell.
    pub fn shell_args(&mut self, args: &[&str]) -> Result<String, String> {
        let quoted: Vec<String> = args.iter().map(|a| shell_quote(a)).collect();
        self.shell(&quoted.join(" "))
    }

    /// Run a shell command and capture raw bytes (used for screenshots).
    pub fn shell_bytes(&mut self, args: &[&str], output: &mut Vec<u8>) -> Result<(), String> {
        let quoted: Vec<String> = args.iter().map(|a| shell_quote(a)).collect();
        let command = quoted.join(" ");
        self.device
            .shell_command(&command, Some(output), None)
            .map_err(|e| format!("Shell command failed: {e}"))?;
        Ok(())
    }

    /// Capture the device framebuffer as PNG bytes.
    pub fn framebuffer_png(&mut self) -> Result<Vec<u8>, String> {
        self.device
            .framebuffer_bytes()
            .map_err(|e| format!("Failed to capture framebuffer: {e}"))
    }
}

// ── Shell quoting ─────────────────────────────────────────────────────────────

/// Wrap `s` in POSIX single-quotes, escaping any embedded single-quotes as
/// `'\''` so that shell metacharacters in the value are never interpreted by
/// the Android device shell.
pub(crate) fn shell_quote(s: &str) -> String {
    // Each single-quote inside the string must be:
    //   1. Close the current single-quoted segment  '
    //   2. Emit the literal single-quote as "\'"
    //   3. Re-open a new single-quoted segment      '
    let inner = s.replace('\'', r"'\''");
    format!("'{inner}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_info_serializes() {
        let info = AndroidDeviceInfo {
            serial: "emulator-5554".to_string(),
            state: "device".to_string(),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("emulator-5554"));
        assert!(json.contains("device"));
    }

    #[test]
    fn shell_quote_plain() {
        assert_eq!(shell_quote("hello"), "'hello'");
    }

    #[test]
    fn shell_quote_with_metacharacters() {
        assert_eq!(shell_quote("a;b&c|d"), "'a;b&c|d'");
    }

    #[test]
    fn shell_quote_with_single_quote() {
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn shell_quote_with_newline() {
        // Newline inside single-quotes is literal text, not a command terminator.
        assert_eq!(shell_quote("a\nb"), "'a\nb'");
    }
}
