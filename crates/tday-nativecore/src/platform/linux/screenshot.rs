// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Linux screenshot capture via subprocess (scrot/grim/import) with X11 fallback.

use crate::platform::types::Screenshot;
use std::path::PathBuf;

/// Capture the full screen.
pub fn capture_screen() -> Result<Screenshot, String> {
    let main = super::display::get_main_display()
        .unwrap_or_else(|| super::display::get_displays().unwrap_or_default().into_iter().next().unwrap_or_else(|| {
            crate::platform::types::DisplayInfo {
                id: 1,
                name: None,
                is_main: true,
                bounds: crate::platform::types::Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 },
                backing_scale_factor: 1.0,
                pixel_width: 1920,
                pixel_height: 1080,
            }
        }));

    capture_region(
        main.bounds.x,
        main.bounds.y,
        main.bounds.width,
        main.bounds.height,
    )
}

/// Capture a rectangular region.
pub fn capture_region(x: f64, y: f64, width: f64, height: f64) -> Result<Screenshot, String> {
    let tmp = temp_png_path();
    let path = tmp.to_str().unwrap();

    let scale = super::display::backing_scale_for_point(x, y);

    // Try scrot first (common on X11 desktops)
    let ok = try_scrot(x as i32, y as i32, width as i32, height as i32, path)
        || try_import(x as i32, y as i32, width as i32, height as i32, path)
        || try_xwd_convert(x as i32, y as i32, width as i32, height as i32, path);

    if !ok {
        // X11 XGetImage fallback
        capture_region_x11(x as i32, y as i32, width as i32, height as i32, path)?;
    }

    let png_data = std::fs::read(path)
        .map_err(|e| format!("Failed to read screenshot from {path}: {e}"))?;
    let _ = std::fs::remove_file(path);

    let (pw, ph) = png_dims(&png_data);
    Ok(Screenshot {
        png_data,
        scale_factor: scale,
        origin_x: x,
        origin_y: y,
        pixel_width: pw,
        pixel_height: ph,
    })
}

/// Capture a window by its X11 window ID.
pub fn capture_window(window_id: u32) -> Result<Screenshot, String> {
    let tmp = temp_png_path();
    let path = tmp.to_str().unwrap();
    let id_str = format!("{window_id}");

    // Try scrot --focused or import with window ID
    let ok = std::process::Command::new("import")
        .args(["-window", &id_str, path])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !ok {
        // Fallback: capture full screen and crop using window bounds from wmctrl
        if let Ok(bounds) = get_window_bounds_wmctrl(window_id) {
            return capture_region(bounds.0, bounds.1, bounds.2, bounds.3);
        }
        return capture_screen();
    }

    let png_data = std::fs::read(path)
        .map_err(|e| format!("Failed to read screenshot: {e}"))?;
    let _ = std::fs::remove_file(path);
    let (pw, ph) = png_dims(&png_data);

    Ok(Screenshot {
        png_data,
        scale_factor: 1.0,
        origin_x: 0.0,
        origin_y: 0.0,
        pixel_width: pw,
        pixel_height: ph,
    })
}

/// Capture a window and return JPEG bytes with metadata.
pub fn capture_window_cg_jpeg(window_id: u32) -> Result<(Vec<u8>, f64, f64, f64, u32, u32), String> {
    let ss = capture_window(window_id)?;
    let jpeg = png_to_jpeg(&ss.png_data)?;
    Ok((jpeg, ss.origin_x, ss.origin_y, ss.scale_factor, ss.pixel_width, ss.pixel_height))
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

fn try_scrot(x: i32, y: i32, w: i32, h: i32, path: &str) -> bool {
    std::process::Command::new("scrot")
        .args(["-a", &format!("{x},{y},{w},{h}"), path])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn try_import(x: i32, y: i32, w: i32, h: i32, path: &str) -> bool {
    std::process::Command::new("import")
        .args(["-window", "root", "-crop",
               &format!("{w}x{h}+{x}+{y}"), path])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn try_xwd_convert(x: i32, y: i32, w: i32, h: i32, path: &str) -> bool {
    let xwd_tmp = format!("/tmp/tday_ss_{}.xwd", std::process::id());
    let ok1 = std::process::Command::new("xwd")
        .args(["-root", "-silent", "-out", &xwd_tmp])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok1 { return false; }

    let ok2 = std::process::Command::new("convert")
        .args([&xwd_tmp, "-crop", &format!("{w}x{h}+{x}+{y}"), "+repage", path])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    let _ = std::fs::remove_file(&xwd_tmp);
    ok2
}

/// X11 XGetImage fallback — captures a screen region directly.
fn capture_region_x11(x: i32, y: i32, w: i32, h: i32, out_path: &str) -> Result<(), String> {
    use x11::xlib::{
        XAllPlanes, XCloseDisplay, XDefaultScreen, XDefaultVisual, XDestroyImage,
        XGetImage, XOpenDisplay, XRootWindow, ZPixmap,
    };

    if w <= 0 || h <= 0 {
        return Err(format!("Invalid dimensions {w}x{h}"));
    }

    unsafe {
        let dpy = XOpenDisplay(std::ptr::null());
        if dpy.is_null() { return Err("XOpenDisplay failed".into()); }

        let screen = XDefaultScreen(dpy);
        let root = XRootWindow(dpy, screen);

        let img = XGetImage(dpy, root, x, y, w as u32, h as u32, XAllPlanes(), ZPixmap);
        if img.is_null() {
            x11::xlib::XCloseDisplay(dpy);
            return Err("XGetImage failed".into());
        }

        let bpp = (*img).bits_per_pixel;
        let data_len = (w * h * (bpp / 8)) as usize;
        let raw = std::slice::from_raw_parts((*img).data as *const u8, data_len);

        // Convert BGRA → RGBA
        let mut rgba = vec![0u8; w as usize * h as usize * 4];
        for (i, chunk) in raw.chunks_exact(4).enumerate() {
            rgba[i * 4]     = chunk[2]; // R
            rgba[i * 4 + 1] = chunk[1]; // G
            rgba[i * 4 + 2] = chunk[0]; // B
            rgba[i * 4 + 3] = 255;      // A
        }

        XDestroyImage(img);
        XCloseDisplay(dpy);

        let img_buf = image::RgbaImage::from_raw(w as u32, h as u32, rgba)
            .ok_or("Failed to build RGBA image")?;
        image::DynamicImage::ImageRgba8(img_buf)
            .save(out_path)
            .map_err(|e| format!("Failed to save PNG: {e}"))
    }
}

fn get_window_bounds_wmctrl(window_id: u32) -> Result<(f64, f64, f64, f64), String> {
    // wmctrl -l -G outputs: win_id desktop_id  x  y  w  h  hostname  title
    let out = std::process::Command::new("wmctrl")
        .args(["-l", "-G"])
        .output()
        .map_err(|e| e.to_string())?;

    let target = format!("{:x}", window_id);
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 6 {
            // parts[0] is hex win id like 0x0400002
            let id = parts[0].trim_start_matches("0x");
            if id.ends_with(&target) || id == &target {
                let x = parts[2].parse::<f64>().unwrap_or(0.0);
                let y = parts[3].parse::<f64>().unwrap_or(0.0);
                let w = parts[4].parse::<f64>().unwrap_or(0.0);
                let h = parts[5].parse::<f64>().unwrap_or(0.0);
                return Ok((x, y, w, h));
            }
        }
    }
    Err(format!("Window {window_id} not found in wmctrl output"))
}

fn temp_png_path() -> PathBuf {
    std::path::Path::new("/tmp").join(format!("tday_ss_{}.png", std::process::id()))
}

fn png_dims(data: &[u8]) -> (u32, u32) {
    image::ImageReader::new(std::io::Cursor::new(data))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((0, 0))
}

pub fn png_to_jpeg(png_data: &[u8]) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(png_data).map_err(|e| format!("PNG decode: {e}"))?;
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg)
        .map_err(|e| format!("JPEG encode: {e}"))?;
    Ok(out)
}
