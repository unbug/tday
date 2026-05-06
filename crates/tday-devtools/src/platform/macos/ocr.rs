/// macOS OCR using Apple Vision framework (VNRecognizeTextRequest).

use super::display;
use crate::platform::types::{Rect, TextMatch};
use cocoa::base::nil;
use cocoa::foundation::NSAutoreleasePool;
use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
use core_foundation::data::CFData;
use objc::runtime::{Class, Object};
use objc::{msg_send, sel, sel_impl};
use std::process::Command;
use std::ptr;

// Vision + ImageIO FFI
#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    fn CGImageSourceCreateWithData(data: CFTypeRef, options: CFTypeRef) -> *mut std::ffi::c_void;
    fn CGImageSourceCreateImageAtIndex(
        src: *mut std::ffi::c_void, idx: usize, opts: CFTypeRef,
    ) -> *mut std::ffi::c_void;
    fn CGImageGetWidth(img: *mut std::ffi::c_void)  -> usize;
    fn CGImageGetHeight(img: *mut std::ffi::c_void) -> usize;
}

#[link(name = "Vision", kind = "framework")]
extern "C" {}

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/// Run OCR on raw PNG bytes.
///
/// * `scale`                  — backing scale factor (pixels → points conversion)
/// * `uses_language_correction` — improves word accuracy but hurts single-char labels
pub fn ocr_image(
    png_data: &[u8],
    scale: Option<f64>,
    uses_language_correction: bool,
) -> Result<Vec<TextMatch>, String> {
    let scale = scale.unwrap_or_else(|| {
        display::get_main_display()
            .map(|d| d.backing_scale_factor)
            .unwrap_or(2.0)
    });
    unsafe { run_vision_ocr(png_data, scale, uses_language_correction) }
}

/// OCR a captured display and return matches that contain `search` (case-insensitive).
pub fn find_text_ocr(
    search: &str,
    display_id: Option<u32>,
    uses_language_correction: bool,
) -> Result<Vec<TextMatch>, String> {
    let displays = display::get_displays()?;
    let (display_idx, disp) = displays
        .iter()
        .enumerate()
        .find(|(_, d)| display_id.map_or(d.is_main, |id| d.id == id))
        .map(|(i, d)| (i + 1, d.clone()))
        .ok_or("Display not found")?;

    // Capture the display
    let tmp = std::env::temp_dir();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = tmp.join(format!("tday_ocr_{}_{}.png", std::process::id(), ts));
    let path_str = path.to_str().ok_or("non-UTF8 path")?;

    let status = Command::new("/usr/sbin/screencapture")
        .args(["-x", "-D", &display_idx.to_string(), path_str])
        .status()
        .map_err(|e| format!("screencapture: {e}"))?;
    if !status.success() {
        return Err(format!("screencapture exited {:?}", status.code()));
    }

    let png_data = std::fs::read(&path).map_err(|e| format!("read capture: {e}"))?;
    let _ = std::fs::remove_file(&path);

    let mut matches = ocr_image(&png_data, Some(disp.backing_scale_factor), uses_language_correction)?;

    let search_lower = search.to_lowercase();
    for m in &mut matches {
        m.x += disp.bounds.x;
        m.y += disp.bounds.y;
        m.bounds.x += disp.bounds.x;
        m.bounds.y += disp.bounds.y;
    }
    matches.retain(|m| m.text.to_lowercase().contains(&search_lower));
    matches.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    Ok(matches)
}

// ──────────────────────────────────────────────────────────────────────────────
// Vision OCR internals
// ──────────────────────────────────────────────────────────────────────────────

unsafe fn run_vision_ocr(
    png_data: &[u8],
    scale: f64,
    uses_language_correction: bool,
) -> Result<Vec<TextMatch>, String> {
    let handler_class = Class::get("VNImageRequestHandler")
        .ok_or("Vision framework not available (requires macOS 10.13+)")?;
    let request_class = Class::get("VNRecognizeTextRequest")
        .ok_or("VNRecognizeTextRequest not available (requires macOS 10.15+)")?;
    let dict_class  = Class::get("NSDictionary").ok_or("NSDictionary unavailable")?;
    let array_class = Class::get("NSArray").ok_or("NSArray unavailable")?;

    let pool = NSAutoreleasePool::new(nil);

    let cf_data = CFData::from_buffer(png_data);
    let image_src = CGImageSourceCreateWithData(cf_data.as_CFTypeRef(), ptr::null());
    if image_src.is_null() {
        let _: () = msg_send![pool, drain];
        return Err("CGImageSourceCreateWithData returned null".into());
    }

    let cg_img = CGImageSourceCreateImageAtIndex(image_src, 0, ptr::null());
    if cg_img.is_null() {
        CFRelease(image_src as CFTypeRef);
        let _: () = msg_send![pool, drain];
        return Err("CGImageSourceCreateImageAtIndex returned null".into());
    }

    let img_w = CGImageGetWidth(cg_img) as f64;
    let img_h = CGImageGetHeight(cg_img) as f64;

    let handler: *mut Object = msg_send![handler_class, alloc];
    let empty_dict: *mut Object = msg_send![dict_class, dictionary];
    let handler: *mut Object = msg_send![handler, initWithCGImage:cg_img options:empty_dict];
    if handler.is_null() {
        CFRelease(cg_img as CFTypeRef);
        CFRelease(image_src as CFTypeRef);
        let _: () = msg_send![pool, drain];
        return Err("VNImageRequestHandler init failed".into());
    }

    let request: *mut Object = msg_send![request_class, alloc];
    let request: *mut Object = msg_send![request, init];
    // VNRequestTextRecognitionLevelAccurate = 0
    let _: () = msg_send![request, setRecognitionLevel: 0isize];
    let _: () = msg_send![request, setUsesLanguageCorrection: uses_language_correction as i8];

    let requests: *mut Object = msg_send![array_class, arrayWithObject: request];
    let mut error: *mut Object = ptr::null_mut();
    let ok: bool = msg_send![handler, performRequests:requests error:&mut error];

    if !ok {
        let desc = if !error.is_null() {
            nsstring_to_string(msg_send![error, localizedDescription])
        } else {
            "unknown Vision error".into()
        };
        let _: () = msg_send![request, release];
        let _: () = msg_send![handler, release];
        CFRelease(cg_img as CFTypeRef);
        CFRelease(image_src as CFTypeRef);
        let _: () = msg_send![pool, drain];
        return Err(format!("Vision OCR failed: {desc}"));
    }

    let results: *mut Object = msg_send![request, results];
    let count: usize = if results.is_null() { 0 } else { msg_send![results, count] };

    let mut matches = Vec::with_capacity(count);
    for i in 0..count {
        let obs: *mut Object = msg_send![results, objectAtIndex: i];
        let cands: *mut Object = msg_send![obs, topCandidates: 1usize];
        let nc: usize = msg_send![cands, count];
        if nc == 0 { continue; }

        let cand: *mut Object = msg_send![cands, objectAtIndex: 0usize];
        let text: String = nsstring_to_string(msg_send![cand, string]);
        let conf: f32 = msg_send![cand, confidence];

        // VNNormalizedRectForImageRect — Vision bbox is (x,y,w,h) normalized, y=bottom
        #[repr(C)] struct CGRect { x: f64, y: f64, width: f64, height: f64 }
        let bbox: CGRect = msg_send![obs, boundingBox];
        let (cx, cy, bounds) = vision_bbox_to_screen(
            bbox.x, bbox.y, bbox.width, bbox.height, img_w, img_h, scale
        );

        matches.push(TextMatch { text, x: cx, y: cy, confidence: conf as f64, bounds, role: None });
    }

    let _: () = msg_send![request, release];
    let _: () = msg_send![handler, release];
    CFRelease(cg_img as CFTypeRef);
    CFRelease(image_src as CFTypeRef);
    let _: () = msg_send![pool, drain];

    Ok(matches)
}

/// Vision returns normalised coords with origin at bottom-left.
/// Convert to screen points (top-left origin).
fn vision_bbox_to_screen(
    norm_x: f64, norm_y: f64, norm_w: f64, norm_h: f64,
    img_w: f64, img_h: f64, scale: f64,
) -> (f64, f64, Rect) {
    let px = norm_x * img_w;
    let pw = norm_w * img_w;
    let ph = norm_h * img_h;
    // Y-flip
    let py = (1.0 - norm_y - norm_h) * img_h;

    let cx = (px + pw / 2.0) / scale;
    let cy = (py + ph / 2.0) / scale;
    let bounds = Rect { x: px / scale, y: py / scale, width: pw / scale, height: ph / scale };
    (cx, cy, bounds)
}

unsafe fn nsstring_to_string(nsstring: *mut Object) -> String {
    if nsstring.is_null() { return String::new(); }
    let utf8: *const i8 = msg_send![nsstring, UTF8String];
    if utf8.is_null() { return String::new(); }
    std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vision_bbox_center_scale2() {
        let (cx, cy, b) = vision_bbox_to_screen(0.0, 0.0, 0.5, 0.25, 1000.0, 800.0, 2.0);
        assert_eq!(b.x, 0.0); assert_eq!(b.y, 300.0);
        assert_eq!(b.width, 250.0); assert_eq!(b.height, 100.0);
        assert_eq!(cx, 125.0); assert_eq!(cy, 350.0);
    }
}
