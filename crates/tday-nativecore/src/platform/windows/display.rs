// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Windows display enumeration and coordinate utilities.

use crate::platform::types::{DisplayInfo, Rect};
use std::mem;
use windows::Win32::Foundation::{BOOL, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

struct MonitorEnumData {
    monitors: Vec<DisplayInfo>,
    index: u32,
}

/// Enumerate all connected monitors.
pub fn get_displays() -> Result<Vec<DisplayInfo>, String> {
    let mut data = MonitorEnumData { monitors: Vec::new(), index: 0 };
    unsafe {
        let result = EnumDisplayMonitors(
            HDC::default(),
            None,
            Some(monitor_enum_callback),
            LPARAM(&mut data as *mut _ as isize),
        );
        if !result.as_bool() {
            return Err("EnumDisplayMonitors failed".to_string());
        }
    }
    if data.monitors.is_empty() {
        return Err("No displays found".to_string());
    }
    Ok(data.monitors)
}

unsafe extern "system" fn monitor_enum_callback(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let data = &mut *(lparam.0 as *mut MonitorEnumData);
    let mut monitor_info: MONITORINFOEXW = mem::zeroed();
    monitor_info.monitorInfo.cbSize = mem::size_of::<MONITORINFOEXW>() as u32;

    if GetMonitorInfoW(hmonitor, &mut monitor_info.monitorInfo as *mut _).as_bool() {
        let rect = monitor_info.monitorInfo.rcMonitor;
        let width = (rect.right - rect.left) as f64;
        let height = (rect.bottom - rect.top) as f64;

        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        let _ = GetDpiForMonitor(hmonitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let scale_factor = dpi_x as f64 / 96.0;

        let is_main = (monitor_info.monitorInfo.dwFlags & 0x1) != 0; // MONITORINFOF_PRIMARY

        let name = String::from_utf16_lossy(&monitor_info.szDevice)
            .trim_end_matches('\0')
            .to_string();

        // Use HMONITOR handle cast as u32 ID
        let id = hmonitor.0 as usize as u32;

        data.monitors.push(DisplayInfo {
            id,
            name: if name.is_empty() { None } else { Some(name) },
            is_main,
            bounds: Rect {
                x: rect.left as f64,
                y: rect.top as f64,
                width,
                height,
            },
            backing_scale_factor: scale_factor,
            pixel_width: (width * scale_factor) as u32,
            pixel_height: (height * scale_factor) as u32,
        });

        data.index += 1;
    }
    TRUE
}

/// Get the primary (main) display.
pub fn get_main_display() -> Result<DisplayInfo, String> {
    get_displays()?
        .into_iter()
        .find(|d| d.is_main)
        .ok_or_else(|| "No main display found".to_string())
}

/// Get the backing scale factor for the display containing (x, y).
pub fn backing_scale_for_point(x: f64, y: f64) -> f64 {
    get_displays()
        .ok()
        .and_then(|ds| ds.into_iter().find(|d| d.bounds.contains_point(x, y)))
        .map(|d| d.backing_scale_factor)
        .unwrap_or(1.0)
}

/// Convert screenshot pixel coordinates to screen points.
/// (origin_x, origin_y) is the top-left of the screenshot in screen points.
/// scale is the backing scale factor. (px, py) are pixel coordinates in the image.
pub fn screenshot_px_to_screen(origin_x: f64, origin_y: f64, scale: f64, px: f64, py: f64) -> (f64, f64) {
    (origin_x + px / scale, origin_y + py / scale)
}

/// Get virtual screen bounding box (union of all monitors).
pub fn get_virtual_screen_bounds() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_screenshot_px_to_screen_retina() {
        let (sx, sy) = screenshot_px_to_screen(100.0, 200.0, 2.0, 200.0, 100.0);
        assert_eq!(sx, 200.0);
        assert_eq!(sy, 250.0);
    }

    #[test]
    fn test_screenshot_px_to_screen_non_retina() {
        let (sx, sy) = screenshot_px_to_screen(50.0, 50.0, 1.0, 100.0, 100.0);
        assert_eq!(sx, 150.0);
        assert_eq!(sy, 150.0);
    }
}
