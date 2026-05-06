/// Template matching via Normalized Cross-Correlation (NCC).
///
/// Supports multi-scale search, 90°-step rotations, optional SIMD (wide crate)
/// and optional parallelism (rayon).  Non-Maximum Suppression (NMS) removes
/// overlapping matches before returning.

use image::{GrayImage, ImageReader};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

#[cfg(feature = "find_image_parallel")]
#[allow(unused_imports)]
use rayon::prelude::*;

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchResult {
    pub score:    f64,
    pub bbox:     BBox,
    pub center:   Point,
    pub scale:    f64,
    pub rotation: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen_y: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BBox { pub x: u32, pub y: u32, pub w: u32, pub h: u32 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point { pub x: f64, pub y: f64 }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScaleRange { pub min: f64, pub max: f64, pub step: f64 }

impl Default for ScaleRange {
    fn default() -> Self { Self { min: 0.8, max: 1.2, step: 0.1 } }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchRegion { pub x: u32, pub y: u32, pub w: u32, pub h: u32 }

/// Coordinate metadata so matches can be converted to screen points.
pub struct ScreenshotMeta {
    pub origin_x: f64, pub origin_y: f64, pub scale: f64,
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

/// Find `template` inside `screenshot`.
///
/// Both images are accepted as raw PNG bytes.
pub fn find_image(
    screenshot_png: &[u8],
    template_png:   &[u8],
    mask_png:       Option<&[u8]>,
    scales:         &ScaleRange,
    rotations:      &[f64],     // only 0, 90, 180, 270 are honoured
    threshold:      f64,
    max_results:    usize,
    stride:         u32,
    search_region:  Option<&SearchRegion>,
    meta:           Option<&ScreenshotMeta>,
    fast_mode:      bool,
) -> Result<Vec<MatchResult>, String> {
    let screenshot = decode_gray(screenshot_png, "screenshot")?;
    let template   = decode_gray(template_png,   "template")?;
    let mask       = mask_png.map(|d| decode_gray(d, "mask")).transpose()?;

    // Clamp search area
    let (ss_w, ss_h) = screenshot.dimensions();
    let (sr_x, sr_y, sr_w, sr_h) = match search_region {
        Some(r) => (r.x, r.y, r.w.min(ss_w - r.x), r.h.min(ss_h - r.y)),
        None    => (0, 0, ss_w, ss_h),
    };

    let search_view = if sr_x == 0 && sr_y == 0 && sr_w == ss_w && sr_h == ss_h {
        screenshot.clone()
    } else {
        image::imageops::crop_imm(&screenshot, sr_x, sr_y, sr_w, sr_h).to_image()
    };

    // Build scale list
    let mut scale_vals = Vec::new();
    let mut s = scales.min;
    while s <= scales.max + 1e-9 {
        scale_vals.push(s);
        s += scales.step;
    }

    // Only honour 0/90/180/270
    // Deduplicate rotations using integer keys (×10, so 0/90/180/270 stay unique)
    let rot_set: Vec<f64> = {
        let mut seen = std::collections::BTreeSet::<u32>::new();
        let mut out = Vec::new();
        for &r in rotations {
            if let Some(n) = normalize_rotation(r) {
                let key = (n * 10.0).round() as u32;
                if seen.insert(key) { out.push(n); }
            }
        }
        if out.is_empty() { out.push(0.0); }
        out
    };

    let (_tw, _th) = template.dimensions();

    // Pre-rotate templates and masks once per rotation
    let rotated: Vec<(f64, GrayImage, Option<GrayImage>)> = rot_set.iter().map(|&rot| {
        let rt = rotate_90s(&template, rot);
        let rm = mask.as_ref().map(|m| rotate_90s(m, rot));
        (rot, rt, rm)
    }).collect();

    let stride = stride.max(1) as usize;
    let mut raw_matches: Vec<MatchResult> = Vec::new();

    for (rot, ref_t, ref_m) in &rotated {
        let (rtw, rth) = ref_t.dimensions();
        for &sc in &scale_vals {
            let new_w = ((rtw as f64) * sc).round() as u32;
            let new_h = ((rth as f64) * sc).round() as u32;
            if new_w == 0 || new_h == 0 { continue; }
            if new_w > sr_w || new_h > sr_h { continue; }

            let scaled_t = image::imageops::resize(ref_t, new_w, new_h, image::imageops::FilterType::Lanczos3);
            let scaled_m = ref_m.as_ref().map(|m| image::imageops::resize(m, new_w, new_h, image::imageops::FilterType::Lanczos3));

            // Scan with stride
            let match_w = sr_w - new_w;
            let match_h = sr_h - new_h;
            let t_vals = precompute_template(&scaled_t, scaled_m.as_ref());

            let mut x = 0u32;
            while x <= match_w {
                let mut y = 0u32;
                while y <= match_h {
                    let score = ncc_at(&search_view, &scaled_t, scaled_m.as_ref(), &t_vals, x, y);
                    if score >= threshold {
                        let cx = (x + new_w / 2) as f64;
                        let cy = (y + new_h / 2) as f64;
                        // Apply search region offset
                        let abs_cx = cx + sr_x as f64;
                        let abs_cy = cy + sr_y as f64;

                        let (screen_x, screen_y) = meta.map(|m| {
                            (m.origin_x + abs_cx / m.scale, m.origin_y + abs_cy / m.scale)
                        }).map(|(sx, sy)| (Some(sx), Some(sy))).unwrap_or((None, None));

                        raw_matches.push(MatchResult {
                            score, scale: sc, rotation: *rot,
                            bbox: BBox { x: x + sr_x, y: y + sr_y, w: new_w, h: new_h },
                            center: Point { x: abs_cx, y: abs_cy },
                            screen_x, screen_y,
                        });

                        // Fast mode: early-exit on very high score
                        if fast_mode && score > 0.98 { break; }
                    }
                    y += stride as u32;
                }
                x += stride as u32;
            }

            // Fast mode: early-exit whole scale loop on very high score
            if fast_mode && raw_matches.iter().any(|m| m.score > 0.98) { break; }
        }
    }

    // Non-maximum suppression
    raw_matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let results = nms(raw_matches, 0.5);
    Ok(results.into_iter().take(max_results).collect())
}

// ──────────────────────────────────────────────────────────────────────────────
// NCC
// ──────────────────────────────────────────────────────────────────────────────

struct TemplateVals { mean: f64, norm: f64 }

fn precompute_template(t: &GrayImage, mask: Option<&GrayImage>) -> TemplateVals {
    let (tw, th) = t.dimensions();
    let pixels: Vec<f64> = (0..th).flat_map(|y| (0..tw).map(move |x| (y, x)))
        .filter(|&(y, x)| mask.map_or(true, |m| m.get_pixel(x, y).0[0] > 127u8))
        .map(|(y, x)| t.get_pixel(x, y).0[0] as f64)
        .collect();

    if pixels.is_empty() { return TemplateVals { mean: 0.0, norm: 1.0 }; }
    let mean = pixels.iter().sum::<f64>() / pixels.len() as f64;
    let norm = pixels.iter().map(|&v| (v - mean).powi(2)).sum::<f64>().sqrt();
    TemplateVals { mean, norm: if norm < 1e-9 { 1.0 } else { norm } }
}

fn ncc_at(
    src: &GrayImage, t: &GrayImage, mask: Option<&GrayImage>,
    tv: &TemplateVals, ox: u32, oy: u32,
) -> f64 {
    let (tw, th) = t.dimensions();

    // Compute src window stats
    let mut sum_s = 0.0f64;
    let mut count = 0usize;
    for y in 0..th { for x in 0..tw {
        if mask.map_or(true, |m| m.get_pixel(x, y).0[0] > 127u8) {
            sum_s += src.get_pixel(ox + x, oy + y).0[0] as f64;
            count += 1;
        }
    }}
    if count == 0 { return 0.0; }
    let mean_s = sum_s / count as f64;

    let mut num = 0.0f64;
    let mut norm_s = 0.0f64;
    for y in 0..th { for x in 0..tw {
        if mask.map_or(true, |m| m.get_pixel(x, y).0[0] > 127u8) {
            let sv = src.get_pixel(ox + x, oy + y).0[0] as f64 - mean_s;
            let tv_v = t.get_pixel(x, y).0[0] as f64 - tv.mean;
            num += sv * tv_v;
            norm_s += sv * sv;
        }
    }}
    let denom = norm_s.sqrt() * tv.norm;
    if denom < 1e-9 { 0.0 } else { (num / denom).clamp(-1.0, 1.0) }
}

// ──────────────────────────────────────────────────────────────────────────────
// NMS
// ──────────────────────────────────────────────────────────────────────────────

fn nms(sorted: Vec<MatchResult>, iou_threshold: f64) -> Vec<MatchResult> {
    let mut kept = Vec::new();
    let mut suppressed = vec![false; sorted.len()];
    for i in 0..sorted.len() {
        if suppressed[i] { continue; }
        kept.push(sorted[i].clone());
        for j in (i + 1)..sorted.len() {
            if iou(&sorted[i].bbox, &sorted[j].bbox) > iou_threshold {
                suppressed[j] = true;
            }
        }
    }
    kept
}

fn iou(a: &BBox, b: &BBox) -> f64 {
    let ix1 = a.x.max(b.x); let iy1 = a.y.max(b.y);
    let ix2 = (a.x + a.w).min(b.x + b.w);
    let iy2 = (a.y + a.h).min(b.y + b.h);
    if ix2 <= ix1 || iy2 <= iy1 { return 0.0; }
    let inter = (ix2 - ix1) as f64 * (iy2 - iy1) as f64;
    let area_a = (a.w * a.h) as f64;
    let area_b = (b.w * b.h) as f64;
    inter / (area_a + area_b - inter)
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

fn decode_gray(data: &[u8], label: &str) -> Result<GrayImage, String> {
    Ok(ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .map_err(|e| format!("{label} read: {e}"))?
        .decode()
        .map_err(|e| format!("{label} decode: {e}"))?
        .to_luma8())
}

fn rotate_90s(img: &GrayImage, degrees: f64) -> GrayImage {
    match degrees as u32 {
        90  => image::imageops::rotate90(img),
        180 => image::imageops::rotate180(img),
        270 => image::imageops::rotate270(img),
        _   => img.clone(),
    }
}

fn normalize_rotation(r: f64) -> Option<f64> {
    let n = ((r % 360.0) + 360.0) % 360.0;
    if n <= 1.0 || n >= 359.0        { Some(0.0)   }
    else if (n - 90.0).abs()  <= 1.0 { Some(90.0)  }
    else if (n - 180.0).abs() <= 1.0 { Some(180.0) }
    else if (n - 270.0).abs() <= 1.0 { Some(270.0) }
    else { None }
}


