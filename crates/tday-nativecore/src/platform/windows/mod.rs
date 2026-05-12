// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Windows platform backend for tday-nativecore.
//!
//! Implements all computer-use automation APIs using:
//! - UI Automation (IUIAutomation) for accessibility tree
//! - SendInput for mouse/keyboard input
//! - BitBlt/GDI for screen capture
//! - Windows.Media.Ocr (WinRT) for OCR
//! - EnumDisplayMonitors for multi-monitor support
//! - Win32 process APIs for app management

pub mod app;
pub mod display;
pub mod input;
pub mod ocr;
pub mod screenshot;
pub mod uia;
pub mod window;

pub use app::*;
pub use display::{backing_scale_for_point, get_displays, get_main_display, screenshot_px_to_screen};
pub use input::{check_accessibility, click, drag, get_cursor_position, move_mouse, press_key,
                scroll, type_text, MouseButton};
pub use ocr::{find_text_ocr, ocr_image};
pub use screenshot::{capture_region, capture_screen, capture_window, capture_window_cg_jpeg};
pub use uia::{
    AXRef, ax_click, ax_find_text, ax_perform_action, ax_select, ax_set_value,
    element_at_point, frontmost_pid, pid_for_window, raise_windows, resize_window_by_pid,
    take_snapshot, ax_find_elements, ax_get_focused, ElementInfo,
};
pub use window::{find_window_by_id_direct, find_windows_by_app, list_windows};

/// Initialize Windows-specific process settings.
/// Call this early in main().
/// Sets DPI awareness to Per-Monitor V2 for correct multi-monitor coordinate handling.
pub fn init() -> Result<(), String> {
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    unsafe {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
            .map_err(|e| format!("Failed to set DPI awareness: {}", e))?;
    }
    Ok(())
}
