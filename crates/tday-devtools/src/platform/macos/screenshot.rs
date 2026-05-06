/// macOS screenshot capture using `screencapture` CLI + CGWindowListCreateImage.

use super::{display, window};
use crate::platform::types::Screenshot;
use core_graphics::window::{kCGWindowImageBoundsIgnoreFraming, kCGWindowListOptionIncludingWindow};
use std::io::Cursor;
use std::process::Command;
use tempfile::tempdir;
use thiserror::Error;

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum ScreenshotError {
    #[error("capture failed: {0}")]
    CaptureFailed(String),
    #[error("window not found: {0}")]
    WindowNotFound(u32),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

pub fn capture_screen() -> Result<Screenshot, String> {
    let tmp = tempdir().map_err(|e| e.to_string())?;
    let path = tmp.path().join("ss.png");
    run_screencapture(&["-x", "-C", "-t", "png", path_str(&path)?])?;

    let info = display::get_main_display().ok();
    let (scale, ox, oy) = info
        .map(|d| (d.backing_scale_factor, d.bounds.x, d.bounds.y))
        .unwrap_or((2.0, 0.0, 0.0));

    let png_data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let (pw, ph) = png_dims(&png_data);
    Ok(Screenshot { png_data, scale_factor: scale, origin_x: ox, origin_y: oy, pixel_width: pw, pixel_height: ph })
}

#[allow(dead_code)]
pub fn capture_region(x: f64, y: f64, width: f64, height: f64) -> Result<Screenshot, String> {
    let tmp = tempdir().map_err(|e| e.to_string())?;
    let path = tmp.path().join("ss.png");
    let xi = x as i32; let yi = y as i32;
    let wi = width as i32; let hi = height as i32;
    let region = format!("{xi},{yi},{wi},{hi}");
    run_screencapture(&["-x", "-R", &region, "-t", "png", path_str(&path)?])?;

    let scale = display::backing_scale_for_point(x, y);
    let png_data = std::fs::read(&path).map_err(|e| e.to_string())?;
    let (pw, ph) = png_dims(&png_data);
    Ok(Screenshot {
        png_data, scale_factor: scale,
        origin_x: f64::from(xi), origin_y: f64::from(yi),
        pixel_width: pw, pixel_height: ph,
    })
}

#[allow(dead_code)]
pub fn capture_window(window_id: u32) -> Result<Screenshot, String> {
    let tmp = tempdir().map_err(|e| e.to_string())?;
    let path = tmp.path().join("ss.png");
    run_screencapture(&["-x", "-o", "-l", &window_id.to_string(), "-t", "png", path_str(&path)?])
        .map_err(|_| format!("Window {} not found or capture failed", window_id))?;

    let png_data = std::fs::read(&path).map_err(|e| e.to_string())?;
    if png_data.is_empty() {
        return Err(format!("Window {window_id} produced empty capture"));
    }

    let winfo = window::find_window_by_id_direct(window_id)
        .map_err(|e| e)?
        .ok_or_else(|| format!("Window {window_id} not found"))?;

    let scale = display::backing_scale_for_point(winfo.bounds.x, winfo.bounds.y);
    let (pw, ph) = png_dims(&png_data);
    Ok(Screenshot {
        png_data, scale_factor: scale,
        origin_x: winfo.bounds.x, origin_y: winfo.bounds.y,
        pixel_width: pw, pixel_height: ph,
    })
}

/// Fast window capture via CoreGraphics (no process spawn, no PNG roundtrip).
/// Returns (jpeg_bytes, origin_x, origin_y, scale, pixel_w, pixel_h).
pub fn capture_window_cg_jpeg(window_id: u32)
    -> Result<(Vec<u8>, f64, f64, f64, u32, u32), String>
{
    let winfo = window::find_window_by_id_direct(window_id)?
        .ok_or_else(|| format!("Window {window_id} not found"))?;

    let null_rect = unsafe { core_graphics::display::CGRectNull };
    let cg_image = core_graphics::window::create_image(
        null_rect,
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageBoundsIgnoreFraming,
    )
    .ok_or_else(|| "CGWindowListCreateImage returned null".to_string())?;

    let pw = cg_image.width() as u32;
    let ph = cg_image.height() as u32;
    let scale = if winfo.bounds.width > 0.0 {
        pw as f64 / winfo.bounds.width
    } else {
        display::backing_scale_for_point(winfo.bounds.x, winfo.bounds.y)
    };

    let jpeg = cg_image_to_jpeg(&cg_image)?;
    Ok((jpeg, winfo.bounds.x, winfo.bounds.y, scale, pw, ph))
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

fn run_screencapture(args: &[&str]) -> Result<(), String> {
    let out = Command::new("screencapture")
        .args(args)
        .output()
        .map_err(|e| format!("screencapture exec: {e}"))?;
    if out.status.success() { Ok(()) }
    else { Err(String::from_utf8_lossy(&out.stderr).into_owned()) }
}

fn path_str(p: &std::path::Path) -> Result<&str, String> {
    p.to_str().ok_or_else(|| "non-UTF-8 path".to_string())
}

fn png_dims(data: &[u8]) -> (u32, u32) {
    image::ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .unwrap_or((0, 0))
}

/// Convert a `CGImage` to JPEG bytes (BGRA → RGB → JPEG encode).
fn cg_image_to_jpeg(cg_image: &core_graphics::image::CGImage) -> Result<Vec<u8>, String> {
    let width  = cg_image.width();
    let height = cg_image.height();
    let bpr    = cg_image.bytes_per_row();
    let data   = cg_image.data();
    let raw    = data.bytes();

    let expected = height * bpr;
    if raw.len() < expected {
        return Err(format!("CGImage buffer too short: {} < {}", raw.len(), expected));
    }

    // BGRA → RGB
    let mut rgb = vec![0u8; width * height * 3];
    for y in 0..height {
        let row = &raw[y * bpr..][..width * 4];
        let out = &mut rgb[y * width * 3..][..width * 3];
        for (src, dst) in row.chunks_exact(4).zip(out.chunks_exact_mut(3)) {
            dst[0] = src[2]; // R
            dst[1] = src[1]; // G
            dst[2] = src[0]; // B
        }
    }

    let img = image::RgbImage::from_raw(width as u32, height as u32, rgb)
        .ok_or_else(|| "Failed to build RgbImage from CGImage data".to_string())?;

    let mut buf = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, crate::JPEG_QUALITY);
    img.write_with_encoder(enc)
        .map_err(|e| format!("JPEG encode: {e}"))?;
    Ok(buf)
}
