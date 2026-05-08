// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

pub mod types;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

// ──────────────────────────────────────────────────────────────────────────────
// Unified platform facade (macOS)
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
#[allow(unused_imports)]
pub use macos::{
    // App
    activate_app, activate_by_pid, find_app_pid, is_running, launch_app, list_apps, quit_app,
    resize_window,
    is_chrome_browser, is_electron_app_by_pid, is_electron_app_by_name,
    // AX
    ax_click, ax_find_text, ax_perform_action, ax_select, ax_set_value, element_at_point,
    frontmost_pid, pid_for_window, raise_windows, resize_window_by_pid, take_snapshot, AXRef,
    // Display
    backing_scale_for_point, get_displays, get_main_display, screenshot_px_to_screen,
    // Input
    check_accessibility, click, drag, get_cursor_position, move_mouse, press_key, scroll,
    type_text, MouseButton,
    // OCR
    find_text_ocr, ocr_image,
    // Screenshot
    capture_region, capture_screen, capture_window, capture_window_cg_jpeg,
    // Window
    find_window_by_id_direct, find_windows_by_app, list_windows,
};

// ──────────────────────────────────────────────────────────────────────────────
// Unified platform facade (Windows)
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
#[allow(unused_imports)]
pub use windows::{
    // App
    activate_app, activate_by_pid, find_app_pid, is_running, launch_app, list_apps, quit_app,
    resize_window,
    is_chrome_browser, is_electron_app_by_pid, is_electron_app_by_name,
    // AX
    ax_click, ax_find_text, ax_perform_action, ax_select, ax_set_value, element_at_point,
    frontmost_pid, pid_for_window, raise_windows, resize_window_by_pid, take_snapshot, AXRef,
    // Display
    backing_scale_for_point, get_displays, get_main_display, screenshot_px_to_screen,
    // Input
    check_accessibility, click, drag, get_cursor_position, move_mouse, press_key, scroll,
    type_text, MouseButton,
    // OCR
    find_text_ocr, ocr_image,
    // Screenshot
    capture_region, capture_screen, capture_window, capture_window_cg_jpeg,
    // Window
    find_window_by_id_direct, find_windows_by_app, list_windows,
};

// ──────────────────────────────────────────────────────────────────────────────
// Unified platform facade (Linux)
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
#[allow(unused_imports)]
pub use linux::{
    // App
    activate_app, activate_by_pid, find_app_pid, is_running, launch_app, list_apps, quit_app,
    resize_window,
    is_chrome_browser, is_electron_app_by_pid, is_electron_app_by_name,
    // AX
    ax_click, ax_find_text, ax_perform_action, ax_select, ax_set_value, element_at_point,
    frontmost_pid, pid_for_window, raise_windows, resize_window_by_pid, take_snapshot, AXRef,
    // Display
    backing_scale_for_point, get_displays, get_main_display, screenshot_px_to_screen,
    // Input
    check_accessibility, click, drag, get_cursor_position, move_mouse, press_key, scroll,
    type_text, MouseButton,
    // OCR
    find_text_ocr, ocr_image,
    // Screenshot
    capture_region, capture_screen, capture_window, capture_window_cg_jpeg,
    // Window
    find_window_by_id_direct, find_windows_by_app, list_windows,
};
