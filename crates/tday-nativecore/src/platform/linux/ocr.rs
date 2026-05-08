// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Linux OCR via Tesseract subprocess.

use crate::platform::types::{Rect, TextMatch};

/// Run OCR on raw PNG bytes using Tesseract.
pub fn ocr_image(
    png_data: &[u8],
    scale: Option<f64>,
    _uses_language_correction: bool,
) -> Result<Vec<TextMatch>, String> {
    let scale = scale.unwrap_or_else(|| {
        super::display::backing_scale_for_point(0.0, 0.0)
    });

    let tmp_png = format!("/tmp/tday_ocr_in_{}.png", std::process::id());
    let tmp_tsv = format!("/tmp/tday_ocr_{}", std::process::id());

    std::fs::write(&tmp_png, png_data)
        .map_err(|e| format!("Failed to write OCR input PNG: {e}"))?;

    // Run tesseract with TSV output for bounding boxes
    let status = std::process::Command::new("tesseract")
        .args([&tmp_png, &tmp_tsv, "tsv"])
        .status()
        .map_err(|e| format!("Tesseract not found (install tesseract-ocr): {e}"))?;

    let _ = std::fs::remove_file(&tmp_png);

    let tsv_path = format!("{tmp_tsv}.tsv");
    let tsv = std::fs::read_to_string(&tsv_path)
        .map_err(|e| format!("Failed to read tesseract output: {e}"))?;
    let _ = std::fs::remove_file(&tsv_path);

    Ok(parse_tsv(&tsv, scale))
}

/// Capture a display and find all occurrences of `search` text via OCR.
pub fn find_text_ocr(
    search: &str,
    display_id: Option<u32>,
    uses_language_correction: bool,
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

    let ss = super::screenshot::capture_region(
        disp.bounds.x,
        disp.bounds.y,
        disp.bounds.width,
        disp.bounds.height,
    )?;

    let search_lower = search.to_lowercase();
    let all_matches = ocr_image(&ss.png_data, Some(ss.scale_factor), uses_language_correction)?;

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

/// Parse Tesseract TSV output into TextMatch list.
fn parse_tsv(tsv: &str, scale: f64) -> Vec<TextMatch> {
    let mut matches = Vec::new();
    for line in tsv.lines().skip(1) {
        let cols: Vec<&str> = line.split('\t').collect();
        // TSV columns: level page_num block_num par_num line_num word_num left top width height conf text
        if cols.len() < 12 { continue; }
        let conf: f64 = cols[10].parse().unwrap_or(-1.0);
        if conf < 0.0 { continue; }
        let text = cols[11].trim().to_string();
        if text.is_empty() { continue; }

        let px = cols[6].parse::<f64>().unwrap_or(0.0) / scale;
        let py = cols[7].parse::<f64>().unwrap_or(0.0) / scale;
        let pw = cols[8].parse::<f64>().unwrap_or(0.0) / scale;
        let ph = cols[9].parse::<f64>().unwrap_or(0.0) / scale;

        matches.push(TextMatch {
            text,
            x: px + pw / 2.0,
            y: py + ph / 2.0,
            confidence: conf / 100.0,
            bounds: Rect { x: px, y: py, width: pw, height: ph },
            role: None,
        });
    }
    matches
}
