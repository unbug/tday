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
    pub fn shell_args(&mut self, args: &[&str]) -> Result<String, String> {
        self.shell(&args.join(" "))
    }

    /// Run a shell command and capture raw bytes (used for screenshots).
    pub fn shell_bytes(&mut self, args: &[&str], output: &mut Vec<u8>) -> Result<(), String> {
        let command = args.join(" ");
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
}
