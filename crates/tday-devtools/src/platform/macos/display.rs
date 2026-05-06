/// macOS display helpers — scale factor, display list, coordinate conversions.

use crate::platform::types::{DisplayInfo, Rect};
use core_graphics::display::{CGDisplay, CGMainDisplayID};

pub fn get_displays() -> Result<Vec<DisplayInfo>, String> {
    let mut ids = [0u32; 16];
    let mut count: u32 = 0;
    let ret = unsafe { core_graphics::display::CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
    if ret != 0 {
        return Err(format!("CGGetActiveDisplayList failed: {ret}"));
    }

    let main_id = unsafe { CGMainDisplayID() };
    Ok(ids[..count as usize]
        .iter()
        .map(|&id| {
            let d = CGDisplay::new(id);
            let b = d.bounds();
            DisplayInfo {
                id,
                name: None,
                is_main: id == main_id,
                bounds: Rect {
                    x: b.origin.x,
                    y: b.origin.y,
                    width: b.size.width,
                    height: b.size.height,
                },
                backing_scale_factor: get_backing_scale(id),
                pixel_width:  d.pixels_wide() as u32,
                pixel_height: d.pixels_high() as u32,
            }
        })
        .collect())
}

pub fn get_main_display() -> Result<DisplayInfo, String> {
    get_displays()?
        .into_iter()
        .find(|d| d.is_main)
        .ok_or_else(|| "No main display".to_string())
}

/// Return the backing-pixel scale factor for the display that contains `(x, y)`.
/// Falls back to 2.0 (Retina default) when no display claims the point.
pub fn backing_scale_for_point(x: f64, y: f64) -> f64 {
    get_displays()
        .ok()
        .and_then(|ds| ds.into_iter().find(|d| d.bounds.contains_point(x, y)))
        .map(|d| d.backing_scale_factor)
        .unwrap_or(2.0)
}

fn get_backing_scale(display_id: u32) -> f64 {
    unsafe {
        use cocoa::base::{id, nil};
        use cocoa::foundation::NSArray;
        use objc::{msg_send, sel, sel_impl};

        let screens: id = msg_send![objc::class!(NSScreen), screens];
        let count: usize = NSArray::count(screens) as usize;
        for i in 0..count {
            let screen: id = NSArray::objectAtIndex(screens, i as u64);
            if screen == nil { continue; }
            let desc: id = msg_send![screen, deviceDescription];
            if desc == nil { continue; }
            let key: id = msg_send![
                objc::class!(NSString),
                stringWithUTF8String: c"NSScreenNumber".as_ptr()
            ];
            let num: id = msg_send![desc, objectForKey: key];
            if num != nil {
                let sid: u32 = msg_send![num, unsignedIntValue];
                if sid == display_id {
                    let sf: f64 = msg_send![screen, backingScaleFactor];
                    return sf;
                }
            }
        }
    }
    2.0
}

/// Convert screenshot-pixel coordinates to screen points.
///
/// `origin_x / origin_y` — top-left of the screenshot in screen points  
/// `scale`               — backing scale factor (pixels-per-point)  
/// `px / py`             — pixel position within the screenshot image
#[allow(dead_code)]
pub fn screenshot_px_to_screen(origin_x: f64, origin_y: f64, scale: f64, px: f64, py: f64) -> (f64, f64) {
    (origin_x + px / scale, origin_y + py / scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshot_px_to_screen_retina() {
        let (sx, sy) = screenshot_px_to_screen(100.0, 200.0, 2.0, 200.0, 100.0);
        assert_eq!(sx, 200.0);
        assert_eq!(sy, 250.0);
    }

    #[test]
    fn screenshot_px_to_screen_non_retina() {
        let (sx, sy) = screenshot_px_to_screen(50.0, 50.0, 1.0, 100.0, 100.0);
        assert_eq!(sx, 150.0);
        assert_eq!(sy, 150.0);
    }
}
