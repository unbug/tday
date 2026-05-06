/// Window enumeration via CGWindowListCopyWindowInfo.

use crate::platform::types::{Rect, WindowInfo};
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::window::{
    kCGNullWindowID, kCGWindowBounds, kCGWindowIsOnscreen, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionIncludingWindow,
    kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGWindowNumber, kCGWindowOwnerName,
    kCGWindowOwnerPID, CGWindowListCopyWindowInfo,
};
use std::ffi::c_void;

type CFDict = CFDictionary<*const c_void, *const c_void>;

/// List all visible on-screen windows.
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let opts = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let ptr = unsafe { CGWindowListCopyWindowInfo(opts, kCGNullWindowID) };
    if ptr.is_null() {
        return Err("CGWindowListCopyWindowInfo failed".into());
    }
    let list: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(ptr) };
    let mut out = Vec::new();
    for i in 0..list.len() {
        let dict: CFDict =
            unsafe { CFDictionary::wrap_under_get_rule(*list.get_unchecked(i) as *const _) };
        if let Some(w) = parse_window(&dict) {
            out.push(w);
        }
    }
    Ok(out)
}

/// Fast single-window query (skips full enumeration).
pub fn find_window_by_id_direct(window_id: u32) -> Result<Option<WindowInfo>, String> {
    let ptr = unsafe { CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window_id) };
    if ptr.is_null() {
        return Err("CGWindowListCopyWindowInfo failed".into());
    }
    let list: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(ptr) };
    if list.is_empty() {
        return Ok(None);
    }
    let dict: CFDict =
        unsafe { CFDictionary::wrap_under_get_rule(*list.get_unchecked(0) as *const _) };
    Ok(parse_window(&dict))
}

#[allow(dead_code)]
pub fn find_window_by_id(window_id: u32) -> Result<Option<WindowInfo>, String> {
    find_window_by_id_direct(window_id)
}

/// Find all windows belonging to an app (case-insensitive substring match on owner_name).
#[allow(dead_code)]
pub fn find_windows_by_app(app_name: &str) -> Result<Vec<WindowInfo>, String> {
    let needle = app_name.to_lowercase();
    Ok(list_windows()?
        .into_iter()
        .filter(|w| w.owner_name.to_lowercase().contains(&needle))
        .collect())
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

fn parse_window(dict: &CFDict) -> Option<WindowInfo> {
    let id = get_i64(dict, unsafe { kCGWindowNumber })? as u32;
    Some(WindowInfo {
        id,
        name: get_string(dict, unsafe { kCGWindowName }),
        owner_name: get_string(dict, unsafe { kCGWindowOwnerName }).unwrap_or_default(),
        owner_pid: get_i64(dict, unsafe { kCGWindowOwnerPID }).unwrap_or(0),
        layer: get_i64(dict, unsafe { kCGWindowLayer }).unwrap_or(0),
        is_on_screen: get_i64(dict, unsafe { kCGWindowIsOnscreen }).unwrap_or(0) != 0,
        bounds: get_bounds(dict, unsafe { kCGWindowBounds }).unwrap_or_default(),
    })
}

fn get_value(dict: &CFDict, key: *const c_void) -> Option<CFType> {
    dict.find(key)
        .map(|v| unsafe { CFType::wrap_under_get_rule(*v as *const _) })
}

fn get_string(dict: &CFDict, key: *const core_foundation::string::__CFString) -> Option<String> {
    get_value(dict, key as *const c_void)?
        .downcast::<CFString>()
        .map(|s| s.to_string())
}

fn get_i64(dict: &CFDict, key: *const core_foundation::string::__CFString) -> Option<i64> {
    get_value(dict, key as *const c_void)?
        .downcast::<CFNumber>()?
        .to_i64()
}

fn get_bounds(dict: &CFDict, key: *const core_foundation::string::__CFString) -> Option<Rect> {
    let v = dict.find(key as *const c_void)?;
    let bounds: CFDict =
        unsafe { CFDictionary::wrap_under_get_rule(*v as *const _) };

    let get_f64 = |k: &str| -> Option<f64> {
        let cf_key = CFString::new(k);
        get_value(&bounds, cf_key.as_concrete_TypeRef() as *const c_void)?
            .downcast::<CFNumber>()?
            .to_f64()
    };

    Some(Rect {
        x: get_f64("X")?,
        y: get_f64("Y")?,
        width:  get_f64("Width")?,
        height: get_f64("Height")?,
    })
}
