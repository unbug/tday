// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

pub mod app;
pub mod ax;
pub mod display;
pub mod input;
pub mod ocr;
pub mod screenshot;
pub mod window;

// Re-exports used by the platform facade
pub use app::*;
pub use ax::{AXRef, ax_click, ax_perform_action, ax_select, ax_set_value, element_at_point,
             find_text as ax_find_text, frontmost_pid, pid_for_window, raise_windows, take_snapshot,
             resize_window_by_pid, ax_find_elements, ax_get_focused};
pub use display::{backing_scale_for_point, get_displays, get_main_display, screenshot_px_to_screen};
pub use input::{check_accessibility, click, drag, get_cursor_position, move_mouse, press_key,
                scroll, type_text, MouseButton};
pub use ocr::{find_text_ocr, ocr_image};
pub use screenshot::{capture_region, capture_screen, capture_window, capture_window_cg_jpeg};
pub use window::{find_window_by_id_direct, find_windows_by_app, list_windows};
