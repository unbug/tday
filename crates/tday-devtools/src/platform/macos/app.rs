/// macOS app management — list, launch, quit, activate.

use crate::platform::types::AppInfo;
use cocoa::base::{id, nil};
use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_graphics::window::{
    kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
    kCGWindowOwnerPID, CGWindowListCopyWindowInfo,
};
use objc::{class, msg_send, sel, sel_impl};
use std::collections::HashSet;
use std::ffi::c_void;

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

pub fn list_apps() -> Vec<AppInfo> {
    let mut apps = Vec::new();
    unsafe {
        for app in running_apps() {
            if !is_alive(app) { continue; }
            let name_ns: id = msg_send![app, localizedName];
            if name_ns == nil { continue; }
            let name = nsstring(name_ns);
            if name.is_empty() { continue; }

            let bundle_ns: id = msg_send![app, bundleIdentifier];
            let bundle_id = if bundle_ns != nil { Some(nsstring(bundle_ns)) } else { None };

            let pid:       i32  = msg_send![app, processIdentifier];
            let is_active: bool = msg_send![app, isActive];
            let is_hidden: bool = msg_send![app, isHidden];
            let policy:    i64  = msg_send![app, activationPolicy];
            let is_user_app = policy == 0; // NSApplicationActivationPolicyRegular

            apps.push(AppInfo { name, bundle_id, pid, is_active, is_hidden, is_user_app });
        }
    }
    apps
}

#[allow(dead_code)]
pub fn activate_app(app_name: &str) -> bool {
    unsafe {
        let needle = app_name.to_lowercase();
        for app in running_apps() {
            let name_ns: id = msg_send![app, localizedName];
            if name_ns == nil { continue; }
            if nsstring(name_ns).to_lowercase().contains(&needle) {
                let _: bool = msg_send![app, activateWithOptions: 1u64];
                return true;
            }
        }
    }
    false
}

pub fn activate_by_pid(pid: i32) -> bool {
    unsafe {
        let app: id = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if app != nil {
            let _: bool = msg_send![app, activateWithOptions: 1u64];
            return true;
        }
    }
    false
}

#[allow(dead_code)]
pub fn is_running(app_name: &str) -> bool {
    unsafe {
        let needle = app_name.to_lowercase();
        for app in running_apps() {
            if !is_alive(app) { continue; }
            let policy: i64 = msg_send![app, activationPolicy];
            if policy != 0 { continue; }
            let ns: id = msg_send![app, localizedName];
            if ns != nil && nsstring(ns).to_lowercase().contains(&needle) { return true; }
        }
    }
    false
}

pub fn launch_app(app_name: &str, args: &[String], background: bool) -> Result<(), String> {
    let mut cmd = std::process::Command::new("open");
    if background { cmd.arg("-g"); }
    cmd.arg("-a").arg(app_name);
    if !args.is_empty() { cmd.arg("--args"); cmd.args(args); }

    let out = cmd.output().map_err(|e| format!("open failed: {e}"))?;
    if out.status.success() { Ok(()) }
    else { Err(format!("open -a '{}': {}", app_name, String::from_utf8_lossy(&out.stderr).trim())) }
}

pub fn quit_app(app_name: &str, force: bool) -> Result<u32, String> {
    let mut count = 0u32;
    unsafe {
        let needle = app_name.to_lowercase();
        for app in running_apps() {
            let ns: id = msg_send![app, localizedName];
            if ns == nil { continue; }
            if !nsstring(ns).to_lowercase().contains(&needle) { continue; }
            if force {
                let _: () = msg_send![app, forceTerminate];
            } else {
                let _: () = msg_send![app, terminate];
            }
            count += 1;
        }
    }
    Ok(count)
}

pub fn find_app_pid(app_name: &str) -> Option<i32> {
    let needle = app_name.to_lowercase();
    unsafe {
        for app in running_apps() {
            if !is_alive(app) { continue; }
            let ns: id = msg_send![app, localizedName];
            if ns == nil { continue; }
            if nsstring(ns).to_lowercase().contains(&needle) {
                let pid: i32 = msg_send![app, processIdentifier];
                return Some(pid);
            }
        }
    }
    None
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

unsafe fn running_apps() -> Vec<id> {
    let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
    let list: id = msg_send![ws, runningApplications];
    let count: usize = msg_send![list, count];

    let mut apps: Vec<id> = Vec::new();
    let mut pids: HashSet<i32> = HashSet::new();

    for i in 0..count {
        let app: id = msg_send![list, objectAtIndex: i];
        if is_alive(app) {
            let pid: i32 = msg_send![app, processIdentifier];
            pids.insert(pid);
            apps.push(app);
        }
    }

    // Catch apps that have windows but haven't appeared in NSWorkspace yet
    for pid in window_owner_pids() {
        if pid > 0 && !pids.contains(&pid) {
            let app: id = msg_send![
                class!(NSRunningApplication),
                runningApplicationWithProcessIdentifier: pid
            ];
            if app != nil { pids.insert(pid); apps.push(app); }
        }
    }
    apps
}

unsafe fn window_owner_pids() -> HashSet<i32> {
    let mut pids = HashSet::new();
    let opts = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
    let ptr = CGWindowListCopyWindowInfo(opts, kCGNullWindowID);
    if ptr.is_null() { return pids; }

    let list: CFArray<*const c_void> = CFArray::wrap_under_create_rule(ptr);
    for i in 0..list.len() {
        let dict: CFDictionary<*const c_void, *const c_void> =
            CFDictionary::wrap_under_get_rule(*list.get_unchecked(i) as *const _);
        if let Some(v) = dict.find(kCGWindowOwnerPID as *const c_void) {
            let n: CFNumber = core_foundation::base::CFType::wrap_under_get_rule(*v as *const _)
                .downcast_into().unwrap();
            if let Some(pid) = n.to_i32() { pids.insert(pid); }
        }
    }
    pids
}

unsafe fn is_alive(app: id) -> bool {
    extern "C" { fn kill(pid: i32, sig: i32) -> i32; }
    let pid: i32 = msg_send![app, processIdentifier];
    kill(pid, 0) == 0
}

unsafe fn nsstring(ns: id) -> String {
    if ns == nil { return String::new(); }
    let utf8: *const i8 = msg_send![ns, UTF8String];
    if utf8.is_null() { return String::new(); }
    std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
}

// ──────────────────────────────────────────────────────────────────────────────
// Electron / Chrome detection
// ──────────────────────────────────────────────────────────────────────────────

/// Known Chrome-family bundle identifiers.
const CHROME_BUNDLE_IDS: &[&str] = &[
    "com.google.Chrome",
    "com.google.Chrome.canary",
    "com.brave.Browser",
    "com.microsoft.edgemac",
    "company.thebrowser.Browser",
    "org.chromium.Chromium",
];

/// Check if an app is a Chrome-family browser by its bundle ID.
pub fn is_chrome_browser(bundle_id: Option<&str>, _app_name: &str) -> bool {
    bundle_id.is_some_and(|bid| CHROME_BUNDLE_IDS.contains(&bid))
}

/// Check if a running app is an Electron app by inspecting its bundle for
/// `Contents/Frameworks/Electron Framework.framework`.
pub fn is_electron_app_by_pid(pid: i32) -> bool {
    bundle_path_for_pid(pid)
        .map(|p| is_electron_bundle(&p))
        .unwrap_or(false)
}

/// Check if a non-running app is Electron by searching standard application
/// directories for `<app_name>.app` and inspecting the bundle.
pub fn is_electron_app_by_name(app_name: &str) -> bool {
    find_app_bundle(app_name)
        .map(|p| is_electron_bundle(&p))
        .unwrap_or(false)
}

fn is_electron_bundle(bundle_path: &str) -> bool {
    std::path::Path::new(bundle_path)
        .join("Contents/Frameworks/Electron Framework.framework")
        .exists()
}

/// Get the `.app` bundle path for a running app by PID.
fn bundle_path_for_pid(pid: i32) -> Option<String> {
    unsafe {
        let app: id = msg_send![
            class!(NSRunningApplication),
            runningApplicationWithProcessIdentifier: pid
        ];
        if app == nil { return None; }
        let url: id = msg_send![app, bundleURL];
        if url == nil { return None; }
        let path: id = msg_send![url, path];
        if path == nil { return None; }
        Some(nsstring(path))
    }
}

/// Search standard application directories for `<app_name>.app`.
fn find_app_bundle(app_name: &str) -> Option<String> {
    let dirs = [
        "/Applications",
        "/System/Applications",
        "/System/Applications/Utilities",
    ];
    let home_apps = std::env::var("HOME")
        .ok()
        .map(|h| std::path::PathBuf::from(h).join("Applications"));

    for dir in dirs
        .iter()
        .map(std::path::PathBuf::from)
        .chain(home_apps.into_iter())
    {
        let candidate = dir.join(format!("{}.app", app_name));
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Move and/or resize the main window of an application by name.
pub fn resize_window(
    app_name: &str,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    let pid = find_app_pid(app_name)
        .ok_or_else(|| format!("App '{app_name}' is not running"))?;
    super::ax::resize_window_by_pid(pid, x, y, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chrome_bundle_ids_detected() {
        for bid in CHROME_BUNDLE_IDS {
            assert!(is_chrome_browser(Some(bid), "irrelevant"), "Expected chrome for {bid}");
        }
    }

    #[test]
    fn test_non_chrome_bundle_id() {
        assert!(!is_chrome_browser(Some("com.apple.Safari"), "Safari"));
    }

    #[test]
    fn test_no_bundle_id_not_chrome() {
        assert!(!is_chrome_browser(None, "anything"));
    }

    #[test]
    fn test_electron_bundle_detected() {
        let dir = tempfile::tempdir().unwrap();
        let electron_path = dir.path().join("Contents/Frameworks/Electron Framework.framework");
        std::fs::create_dir_all(&electron_path).unwrap();
        assert!(is_electron_bundle(dir.path().to_str().unwrap()));
    }

    #[test]
    fn test_non_electron_bundle() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_electron_bundle(dir.path().to_str().unwrap()));
    }

    #[test]
    fn test_nonexistent_path_not_electron() {
        assert!(!is_electron_bundle("/nonexistent/path"));
    }
}
