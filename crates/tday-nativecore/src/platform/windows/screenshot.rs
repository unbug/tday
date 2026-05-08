// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Windows screenshot capture using GDI BitBlt.
//!
//! Supports full virtual screen capture (all monitors) and region/window capture.
//! Uses the `image` crate for PNG/JPEG encoding.

use crate::platform::types::Screenshot;
use std::mem;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetDC, GetDIBits, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    SRCCOPY,
};
use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;

/// Capture the entire virtual screen (all monitors combined).
pub fn capture_screen() -> Result<Screenshot, String> {
    use super::display::get_virtual_screen_bounds;
    let (vx, vy, vw, vh) = get_virtual_screen_bounds();

    let png_data = capture_region_gdi(vx, vy, vw, vh)
        .map_err(|e| format!("capture_screen BitBlt failed: {e}"))?;

    let (pw, ph) = png_dims(&png_data);
    let effective_scale = if vw > 0 {
        let s = pw as f64 / vw as f64;
        if (s - 1.0).abs() < 0.01 { 1.0 } else { s }
    } else { 1.0 };

    Ok(Screenshot {
        png_data,
        scale_factor: effective_scale,
        origin_x: vx as f64,
        origin_y: vy as f64,
        pixel_width: pw,
        pixel_height: ph,
    })
}

/// Capture a rectangular region of the screen.
pub fn capture_region(x: f64, y: f64, width: f64, height: f64) -> Result<Screenshot, String> {
    let xi = x as i32;
    let yi = y as i32;
    let wi = width as i32;
    let hi = height as i32;

    let png_data = capture_region_gdi(xi, yi, wi, hi)
        .map_err(|e| format!("capture_region BitBlt failed: {e}"))?;
    let (pw, ph) = png_dims(&png_data);
    let scale = if wi > 0 { let s = pw as f64 / wi as f64; if (s - 1.0).abs() < 0.01 { 1.0 } else { s } } else { 1.0 };

    Ok(Screenshot {
        png_data,
        scale_factor: scale,
        origin_x: xi as f64,
        origin_y: yi as f64,
        pixel_width: pw,
        pixel_height: ph,
    })
}

/// Capture a window by its Win32 HWND (as u32 ID).
pub fn capture_window(window_id: u32) -> Result<Screenshot, String> {
    let hwnd = HWND(window_id as isize as *mut _);
    let bounds = get_window_bounds(hwnd);
    let wi = bounds.2 as i32;
    let hi = bounds.3 as i32;
    if wi <= 0 || hi <= 0 {
        return Err(format!("Window {window_id} has zero dimensions"));
    }
    let png_data = capture_region_gdi(bounds.0 as i32, bounds.1 as i32, wi, hi)
        .map_err(|e| format!("capture_window BitBlt failed: {e}"))?;
    let (pw, ph) = png_dims(&png_data);
    let scale = if wi > 0 { let s = pw as f64 / wi as f64; if (s - 1.0).abs() < 0.01 { 1.0 } else { s } } else { 1.0 };

    Ok(Screenshot {
        png_data,
        scale_factor: scale,
        origin_x: bounds.0,
        origin_y: bounds.1,
        pixel_width: pw,
        pixel_height: ph,
    })
}

/// Capture a window and return JPEG bytes with metadata (matching macOS capture_window_cg_jpeg).
/// Returns (jpeg_bytes, origin_x, origin_y, scale, pixel_width, pixel_height).
pub fn capture_window_cg_jpeg(window_id: u32) -> Result<(Vec<u8>, f64, f64, f64, u32, u32), String> {
    let ss = capture_window(window_id)?;
    let jpeg = png_to_jpeg(&ss.png_data)?;
    Ok((jpeg, ss.origin_x, ss.origin_y, ss.scale_factor, ss.pixel_width, ss.pixel_height))
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

/// Get (x, y, width, height) of a window using DWM extended frame bounds.
fn get_window_bounds(hwnd: HWND) -> (f64, f64, f64, f64) {
    let mut rect = RECT::default();
    let dwm_ok = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut rect as *mut _ as *mut _,
            mem::size_of::<RECT>() as u32,
        ).is_ok()
    };
    if !dwm_ok {
        unsafe { let _ = GetWindowRect(hwnd, &mut rect); }
    }
    (
        rect.left as f64,
        rect.top as f64,
        (rect.right - rect.left) as f64,
        (rect.bottom - rect.top) as f64,
    )
}

/// Capture a screen region using GDI BitBlt and encode to PNG via the `image` crate.
fn capture_region_gdi(x: i32, y: i32, width: i32, height: i32) -> Result<Vec<u8>, String> {
    if width <= 0 || height <= 0 {
        return Err(format!("Invalid capture dimensions: {}x{}", width, height));
    }

    unsafe {
        let screen_dc = GetDC(HWND::default());
        if screen_dc.is_invalid() {
            return Err("GetDC(null) failed".to_string());
        }

        let mem_dc = CreateCompatibleDC(screen_dc);
        if mem_dc.is_invalid() {
            ReleaseDC(HWND::default(), screen_dc);
            return Err("CreateCompatibleDC failed".to_string());
        }

        let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
        if bitmap.is_invalid() {
            DeleteDC(mem_dc);
            ReleaseDC(HWND::default(), screen_dc);
            return Err("CreateCompatibleBitmap failed".to_string());
        }

        let old_bmp = SelectObject(mem_dc, bitmap);
        let blt_ok = BitBlt(mem_dc, 0, 0, width, height, screen_dc, x, y, SRCCOPY).is_ok();

        let result = if blt_ok {
            extract_bitmap_png(mem_dc, bitmap, width, height)
        } else {
            Err("BitBlt failed".to_string())
        };

        SelectObject(mem_dc, old_bmp);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(mem_dc);
        ReleaseDC(HWND::default(), screen_dc);

        result
    }
}

/// Extract BGRA pixel data from a GDI bitmap and encode as PNG.
unsafe fn extract_bitmap_png(dc: HDC, bitmap: HBITMAP, width: i32, height: i32) -> Result<Vec<u8>, String> {
    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default()],
    };

    let row_bytes = width as usize * 4;
    let mut pixels: Vec<u8> = vec![0u8; row_bytes * height as usize];
    let result = GetDIBits(
        dc, bitmap, 0, height as u32,
        Some(pixels.as_mut_ptr() as *mut _),
        &mut bmi,
        DIB_RGB_COLORS,
    );
    if result == 0 {
        return Err("GetDIBits failed".to_string());
    }

    // BGRA → RGBA
    for chunk in pixels.chunks_exact_mut(4) {
        chunk.swap(0, 2);
    }

    // Encode to PNG using the `image` crate
    let img = image::RgbaImage::from_raw(width as u32, height as u32, pixels)
        .ok_or("Failed to construct RGBA image")?;
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode failed: {e}"))?;
    Ok(out)
}

/// Convert PNG bytes to JPEG bytes.
pub fn png_to_jpeg(png_data: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(png_data).map_err(|e| format!("PNG decode: {e}"))?;
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
        .map_err(|e| format!("JPEG encode: {e}"))?;
    Ok(out)
}

fn png_dims(data: &[u8]) -> (u32, u32) {
    image::ImageReader::new(std::io::Cursor::new(data))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_capture_screen_returns_data() {
        match capture_screen() {
            Ok(ss) => {
                assert!(!ss.png_data.is_empty(), "screenshot should not be empty");
                assert!(ss.pixel_width > 0);
                assert!(ss.pixel_height > 0);
            }
            Err(e) => eprintln!("capture_screen failed (may be headless): {e}"),
        }
    }
}
