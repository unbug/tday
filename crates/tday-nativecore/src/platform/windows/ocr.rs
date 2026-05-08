// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Windows OCR using Windows.Media.Ocr (WinRT).
//!
//! Requires Windows 10 version 1903 (build 18362) or later.
//! Falls back to an empty result set on older systems.

use crate::platform::types::{Rect, TextMatch};
use windows::core::Interface;
use windows::Graphics::Imaging::{BitmapDecoder, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

/// Run OCR on raw PNG bytes.
///
/// * `scale` — backing scale factor (pixels → screen-point conversion).
/// * `uses_language_correction` — ignored on Windows; WinRT uses system language.
pub fn ocr_image(
    png_data: &[u8],
    scale: Option<f64>,
    _uses_language_correction: bool,
) -> Result<Vec<TextMatch>, String> {
    let scale = scale.unwrap_or_else(|| {
        super::display::get_main_display()
            .map(|d| d.backing_scale_factor)
            .unwrap_or(1.0)
    });
    run_winrt_ocr(png_data, scale)
}

/// Capture the given display, run OCR, and return text matches containing `search`.
pub fn find_text_ocr(
    search: &str,
    display_id: Option<u32>,
    _uses_language_correction: bool,
) -> Result<Vec<TextMatch>, String> {
    let displays = super::display::get_displays()?;
    let disp = displays
        .iter()
        .find(|d| match display_id {
            None | Some(0) => d.is_main,
            Some(id) => d.id == id,
        })
        .or_else(|| displays.first())
        .cloned()
        .ok_or("No display found")?;

    // Capture the target display region
    let ss = super::screenshot::capture_region(
        disp.bounds.x,
        disp.bounds.y,
        disp.bounds.width,
        disp.bounds.height,
    )?;

    let search_lower = search.to_lowercase();
    let all_matches = run_winrt_ocr(&ss.png_data, ss.scale_factor)?;

    // Offset pixel→screen coordinates
    Ok(all_matches
        .into_iter()
        .filter(|m| m.text.to_lowercase().contains(&search_lower))
        .map(|mut m| {
            m.x += disp.bounds.x;
            m.y += disp.bounds.y;
            m.bounds.x += disp.bounds.x;
            m.bounds.y += disp.bounds.y;
            m
        })
        .collect())
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal WinRT OCR
// ──────────────────────────────────────────────────────────────────────────────

fn run_winrt_ocr(png_data: &[u8], scale: f64) -> Result<Vec<TextMatch>, String> {
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .map_err(|e| format!("OCR engine unavailable (Win10 1903+ required): {e}"))?;

    let bitmap = load_png_to_software_bitmap(png_data)?;

    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("OCR RecognizeAsync failed: {e}"))?
        .get()
        .map_err(|e| format!("OCR async completion failed: {e}"))?;

    let lines = result.Lines().map_err(|e| format!("OCR lines failed: {e}"))?;

    let mut matches = Vec::new();
    for line in lines {
        let words = line.Words().map_err(|e| e.to_string())?;
        for word in words {
            let text = word.Text().map_err(|e| e.to_string())?.to_string();
            let rect = word.BoundingRect().map_err(|e| e.to_string())?;

            // WinRT returns pixel coordinates; divide by scale to get screen points
            let bounds = Rect {
                x: rect.X as f64 / scale,
                y: rect.Y as f64 / scale,
                width: rect.Width as f64 / scale,
                height: rect.Height as f64 / scale,
            };

            matches.push(TextMatch {
                text,
                x: bounds.x + bounds.width / 2.0,
                y: bounds.y + bounds.height / 2.0,
                confidence: 1.0,
                bounds,
                role: None,
            });
        }
    }

    Ok(matches)
}

fn load_png_to_software_bitmap(png_data: &[u8]) -> Result<SoftwareBitmap, String> {
    let stream = InMemoryRandomAccessStream::new()
        .map_err(|e| format!("Failed to create stream: {e}"))?;

    let writer = DataWriter::CreateDataWriter(&stream)
        .map_err(|e| format!("Failed to create writer: {e}"))?;

    writer.WriteBytes(png_data).map_err(|e| format!("Write failed: {e}"))?;
    writer.StoreAsync().map_err(|e| format!("Store failed: {e}"))?.get()
        .map_err(|e| format!("Store async failed: {e}"))?;
    writer.FlushAsync().map_err(|e| format!("Flush failed: {e}"))?.get()
        .map_err(|e| format!("Flush async failed: {e}"))?;
    writer.DetachStream().map_err(|e| format!("DetachStream failed: {e}"))?;

    // Rewind stream to start
    stream.Seek(0).map_err(|e| format!("Seek failed: {e}"))?;

    let decoder = BitmapDecoder::CreateAsync(
        BitmapDecoder::PngDecoderId()
            .map_err(|e| format!("PNG decoder ID failed: {e}"))?,
        &stream,
    )
    .map_err(|e| format!("BitmapDecoder create failed: {e}"))?
    .get()
    .map_err(|e| format!("BitmapDecoder async failed: {e}"))?;

    let software_bitmap = decoder
        .GetSoftwareBitmapAsync()
        .map_err(|e| format!("GetSoftwareBitmap failed: {e}"))?
        .get()
        .map_err(|e| format!("GetSoftwareBitmap async failed: {e}"))?;

    Ok(software_bitmap)
}
