// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Linux display enumeration using XRandR.

use crate::platform::types::{DisplayInfo, Rect};
use x11::xlib::{XCloseDisplay, XDefaultScreen, XOpenDisplay};
use x11::xrandr::{
    XRRFreeScreenResources, XRRGetCrtcInfo, XRRFreeCrtcInfo,
    XRRGetScreenResourcesCurrent, XRRGetOutputInfo, XRRFreeOutputInfo,
    Connection,
};

/// List all connected monitors.
pub fn get_displays() -> Result<Vec<DisplayInfo>, String> {
    unsafe {
        let dpy = XOpenDisplay(std::ptr::null());
        if dpy.is_null() {
            // Fallback: return a single synthetic display
            return Ok(vec![synthetic_display()]);
        }

        let screen = XDefaultScreen(dpy);
        let root = x11::xlib::XRootWindow(dpy, screen);

        let res = XRRGetScreenResourcesCurrent(dpy, root);
        if res.is_null() {
            XCloseDisplay(dpy);
            return Ok(vec![synthetic_display()]);
        }

        let mut displays: Vec<DisplayInfo> = Vec::new();
        let mut is_first = true;

        // Iterate CRTCs to get enabled outputs
        let n_crtcs = (*res).ncrtc;
        for i in 0..n_crtcs {
            let crtc_id = *(*res).crtcs.add(i as usize);
            let crtc = XRRGetCrtcInfo(dpy, res, crtc_id);
            if crtc.is_null() { continue; }

            if (*crtc).width == 0 || (*crtc).height == 0 {
                XRRFreeCrtcInfo(crtc);
                continue;
            }

            let x = (*crtc).x as f64;
            let y = (*crtc).y as f64;
            let w = (*crtc).width as f64;
            let h = (*crtc).height as f64;

            // Attempt to get output name
            let name = if (*crtc).noutput > 0 {
                let out_id = *(*crtc).outputs;
                let out_info = XRRGetOutputInfo(dpy, res, out_id);
                let n = if !out_info.is_null() {
                    let name_slice = std::slice::from_raw_parts(
                        (*out_info).name as *const u8,
                        (*out_info).nameLen as usize,
                    );
                    let s = String::from_utf8_lossy(name_slice).into_owned();
                    XRRFreeOutputInfo(out_info);
                    Some(s)
                } else { None };
                n
            } else { None };

            displays.push(DisplayInfo {
                id: i as u32 + 1,
                name,
                is_main: is_first,
                bounds: Rect { x, y, width: w, height: h },
                backing_scale_factor: 1.0,
                pixel_width: (*crtc).width,
                pixel_height: (*crtc).height,
            });
            is_first = false;
            XRRFreeCrtcInfo(crtc);
        }

        XRRFreeScreenResources(res);
        XCloseDisplay(dpy);

        if displays.is_empty() {
            Ok(vec![synthetic_display()])
        } else {
            Ok(displays)
        }
    }
}

fn synthetic_display() -> DisplayInfo {
    // Fallback when XRandR is unavailable
    DisplayInfo {
        id: 1,
        name: Some("DISPLAY".to_string()),
        is_main: true,
        bounds: Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 },
        backing_scale_factor: 1.0,
        pixel_width: 1920,
        pixel_height: 1080,
    }
}

pub fn get_main_display() -> Option<DisplayInfo> {
    get_displays().ok().and_then(|v| v.into_iter().find(|d| d.is_main))
}

/// Return the display backing scale for a point.
pub fn backing_scale_for_point(_x: f64, _y: f64) -> f64 {
    // Linux fractional scaling is complex; default 1.0
    // Could check GDK_SCALE or QT_SCALE_FACTOR env vars
    std::env::var("GDK_SCALE")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|&s| s > 0.5)
        .unwrap_or(1.0)
}

/// Convert screenshot pixel coordinates to screen point coordinates.
pub fn screenshot_px_to_screen(
    origin_x: f64,
    origin_y: f64,
    scale: f64,
    px: f64,
    py: f64,
) -> (f64, f64) {
    (origin_x + px / scale, origin_y + py / scale)
}
