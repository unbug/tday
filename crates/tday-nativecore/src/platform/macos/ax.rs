// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

/// macOS Accessibility API (AXUIElement) helpers.
///
/// Provides:
/// - Text search in the AX tree (find_text)
/// - Element-at-point lookup
/// - AX action dispatch (click, set_value, select)
/// - Full AX tree snapshot collection for `take_ax_snapshot`
/// - Window raise via AXRaise

use crate::platform::types::{AXNode, Rect, TextMatch};
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::CFString;
use core_graphics::geometry::{CGPoint, CGSize};
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr;
use std::sync::Arc;

// ──────────────────────────────────────────────────────────────────────────────
// FFI types
// ──────────────────────────────────────────────────────────────────────────────

type AXUIElementRef = *mut c_void;
type AXValueRef     = *mut c_void;

const K_AX_VALUE_CGPOINT: u32 = 1;
const K_AX_VALUE_CGSIZE:  u32 = 2;
const K_AX_ERROR_OK: i32 = 0;

const MAX_DEPTH:    u32   = 50;
const MAX_ELEMENTS: usize = 10_000;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32)   -> AXUIElementRef;
    fn AXUIElementCreateSystemWide()            -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        el: AXUIElementRef,
        attr: core_foundation::string::CFStringRef,
        out: *mut core_foundation::base::CFTypeRef,
    ) -> i32;
    fn AXUIElementSetAttributeValue(
        el: AXUIElementRef,
        attr: core_foundation::string::CFStringRef,
        val: core_foundation::base::CFTypeRef,
    ) -> i32;
    fn AXUIElementPerformAction(
        el: AXUIElementRef,
        action: core_foundation::string::CFStringRef,
    ) -> i32;
    fn AXUIElementCopyElementAtPosition(
        app: AXUIElementRef, x: f32, y: f32, out: *mut AXUIElementRef,
    ) -> i32;
    fn AXUIElementGetPid(el: AXUIElementRef, pid: *mut i32) -> i32;
    fn AXValueGetValue(val: AXValueRef, ty: u32, out: *mut c_void) -> bool;
    fn AXValueCreate(ty: u32, value: *const c_void) -> AXValueRef;
}

// ──────────────────────────────────────────────────────────────────────────────
// AXRef — retained, thread-safe handle
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AXRef(Arc<AXRefInner>);

struct AXRefInner(AXUIElementRef);

// Safety: Apple documents AX API as thread-safe; CFRetain/Release are atomic.
unsafe impl Send for AXRefInner {}
unsafe impl Sync for AXRefInner {}

impl Drop for AXRefInner {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { core_foundation::base::CFRelease(self.0 as _); }
        }
    }
}

impl std::fmt::Debug for AXRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AXRef({:p})", self.0.0)
    }
}

impl AXRef {
    /// Create rule: caller already holds +1 refcount (ownership transferred).
    pub(crate) unsafe fn from_create(raw: AXUIElementRef) -> Self {
        AXRef(Arc::new(AXRefInner(raw)))
    }
    /// Get rule: caller has borrowed ref — we CFRetain to take ownership.
    pub(crate) unsafe fn from_get(raw: AXUIElementRef) -> Self {
        if !raw.is_null() { core_foundation::base::CFRetain(raw as _); }
        AXRef(Arc::new(AXRefInner(raw)))
    }
    pub(crate) fn as_raw(&self) -> AXUIElementRef { self.0.0 }
}

// ──────────────────────────────────────────────────────────────────────────────
// Public: find_text (AX tree search)
// ──────────────────────────────────────────────────────────────────────────────

/// Find UI elements whose AXTitle / AXValue / AXDescription contains `search`
/// (case-insensitive). Returns screen coordinates for clicking.
pub fn find_text(search: &str, window_id: Option<u32>) -> Result<Vec<TextMatch>, String> {
    let pid = match window_id {
        Some(wid) => pid_for_window(wid)?,
        None      => frontmost_pid()?,
    };

    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return Err(format!("AXUIElementCreateApplication failed for pid {pid}"));
    }

    let search_lower = search.to_lowercase();
    let mut matches = Vec::new();
    let mut count = 0usize;

    unsafe {
        walk_tree(app, &mut count, 0, &mut |el| {
            let hit = ["AXTitle", "AXValue", "AXDescription"]
                .iter()
                .filter_map(|a| get_string(el, a))
                .find(|s| !s.is_empty() && s.to_lowercase().contains(search_lower.as_str()));

            if let Some(text) = hit {
                if let Some((pos, sz)) = position_and_size(el) {
                    if sz.width > 0.0 && sz.height > 0.0 {
                        let role   = get_string(el, "AXRole");
                        let bounds = Rect { x: pos.x, y: pos.y, width: sz.width, height: sz.height };
                        matches.push(TextMatch {
                            text,
                            x: bounds.x + bounds.width  / 2.0,
                            y: bounds.y + bounds.height / 2.0,
                            confidence: 1.0,
                            bounds,
                            role,
                        });
                    }
                }
            }
        });
        core_foundation::base::CFRelease(app as _);
    }
    Ok(matches)
}

// ──────────────────────────────────────────────────────────────────────────────
// Public: element_at_point
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, serde::Serialize)]
pub struct ElementInfo {
    pub name:     Option<String>,
    pub role:     Option<String>,
    pub value:    Option<String>,
    pub description: Option<String>,
    pub bounds:   Option<Rect>,
    pub pid:      i32,
    pub app_name: Option<String>,
}

pub fn element_at_point(x: f64, y: f64, _app_name: Option<&str>) -> Result<ElementInfo, String> {
    let system_wide = unsafe { AXUIElementCreateSystemWide() };
    if system_wide.is_null() {
        return Err("AXUIElementCreateSystemWide failed".into());
    }

    let mut el: AXUIElementRef = ptr::null_mut();
    let ret = unsafe { AXUIElementCopyElementAtPosition(system_wide, x as f32, y as f32, &mut el) };
    unsafe { core_foundation::base::CFRelease(system_wide as _); }

    if ret != K_AX_ERROR_OK || el.is_null() {
        return Err(format!("No element at ({x},{y}), AX error {ret}"));
    }

    let ax = unsafe { AXRef::from_create(el) };
    let raw = ax.as_raw();

    let mut pid: i32 = 0;
    unsafe { AXUIElementGetPid(raw, &mut pid); }

    let bounds = unsafe { element_bbox(raw) };

    let info = ElementInfo {
        name:        unsafe { get_string(raw, "AXTitle") }
                       .or_else(|| unsafe { get_string(raw, "AXDescription") }),
        role:        unsafe { get_string(raw, "AXRole") },
        value:       unsafe { get_string(raw, "AXValue") },
        description: unsafe { get_string(raw, "AXDescription") },
        bounds,
        pid,
        app_name: None, // could look up via NSRunningApplication if needed
    };
    Ok(info)
}

// ──────────────────────────────────────────────────────────────────────────────
// Public: AX snapshot (full accessibility tree)
// ──────────────────────────────────────────────────────────────────────────────

/// Take a snapshot of the AX tree for the given pid.
/// Returns (root_node, uid→AXRef map, generation).
pub fn take_snapshot(
    pid: i32,
    generation: u64,
) -> Result<(AXNode, HashMap<u32, AXRef>), String> {
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return Err(format!("AXUIElementCreateApplication failed for pid {pid}"));
    }

    let mut refs: HashMap<u32, AXRef> = HashMap::new();
    let mut uid_counter: u32 = 0;

    let node = unsafe { snapshot_element(app, &mut refs, &mut uid_counter, generation, 0) };
    unsafe { core_foundation::base::CFRelease(app as _); }
    Ok((node, refs))
}

unsafe fn snapshot_element(
    el: AXUIElementRef,
    refs: &mut HashMap<u32, AXRef>,
    counter: &mut u32,
    generation: u64,
    depth: u32,
) -> AXNode {
    let uid_n = *counter;
    *counter += 1;
    let uid = format!("a{uid_n}g{generation}");

    // Retain and store
    let ax_ref = AXRef::from_get(el);
    refs.insert(uid_n, ax_ref);

    let role   = get_string(el, "AXRole").unwrap_or_else(|| "unknown".into());
    let label  = get_string(el, "AXTitle").or_else(|| get_string(el, "AXDescription"));
    let value  = get_string(el, "AXValue");
    let bounds = element_bbox(el);
    let enabled = get_bool(el, "AXEnabled");
    let focused = get_bool(el, "AXFocused");

    let mut children = Vec::new();
    if depth < MAX_DEPTH && (*counter as usize) < MAX_ELEMENTS {
        if let Some(kids) = ax_children(el) {
            for i in 0..kids.len() {
                let child = *kids.get_unchecked(i) as AXUIElementRef;
                if !child.is_null() {
                    core_foundation::base::CFRetain(child as _);
                    let node = snapshot_element(child, refs, counter, generation, depth + 1);
                    core_foundation::base::CFRelease(child as _);
                    children.push(node);
                }
            }
        }
    }

    AXNode { uid, role, label, value, description: None, bounds, enabled, focused, children }
}

// ──────────────────────────────────────────────────────────────────────────────
// Public: ax_find_elements — targeted search (much smaller than full snapshot)
// ──────────────────────────────────────────────────────────────────────────────

/// Walk the AX tree for `pid` and return elements that match `text_query`
/// (AXTitle / AXValue / AXDescription, case-insensitive) and/or `role_filter`
/// (exact AXRole string, case-insensitive).  Only matching leaf-info nodes are
/// returned — **children are not included** — so the result is far smaller than
/// `take_snapshot`.  Each returned node has a fresh UID registered in `refs`.
pub fn ax_find_elements(
    pid: i32,
    text_query: Option<&str>,
    role_filter: Option<&str>,
    max_results: usize,
    generation: u64,
) -> Result<(Vec<AXNode>, HashMap<u32, AXRef>), String> {
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return Err(format!("AXUIElementCreateApplication failed for pid {pid}"));
    }

    let text_lower = text_query.map(|s| s.to_lowercase());
    let role_lower = role_filter.map(|s| s.to_lowercase());
    let mut nodes: Vec<AXNode> = Vec::new();
    let mut refs:  HashMap<u32, AXRef> = HashMap::new();
    let mut uid_counter: u32 = 0;
    let mut walk_count: usize = 0;

    unsafe {
        walk_tree(app, &mut walk_count, 0, &mut |el| {
            if nodes.len() >= max_results { return; }

            let role = get_string(el, "AXRole").unwrap_or_else(|| "unknown".into());

            // Role filter
            if let Some(rf) = &role_lower {
                if !role.to_lowercase().contains(rf.as_str()) { return; }
            }

            // Text filter
            if let Some(tq) = &text_lower {
                let hit = ["AXTitle", "AXValue", "AXDescription"]
                    .iter()
                    .any(|a| get_string(el, a).map_or(false, |s| s.to_lowercase().contains(tq.as_str())));
                if !hit { return; }
            } else if role_lower.is_none() {
                // Neither filter set — match everything (dangerous for large apps)
                // Limit to interactive roles only
                let interactive = matches!(
                    role.as_str(),
                    "AXButton" | "AXTextField" | "AXTextArea" | "AXCheckBox"
                    | "AXRadioButton" | "AXComboBox" | "AXPopUpButton" | "AXSlider"
                    | "AXLink" | "AXMenuItem" | "AXTab" | "AXStaticText"
                );
                if !interactive { return; }
            }

            let uid_n = uid_counter;
            uid_counter += 1;
            let uid = format!("a{uid_n}g{generation}");

            let ax_ref = AXRef::from_get(el);
            refs.insert(uid_n, ax_ref);

            let label  = get_string(el, "AXTitle").or_else(|| get_string(el, "AXDescription"));
            let value  = get_string(el, "AXValue");
            let bounds = element_bbox(el);
            let enabled = get_bool(el, "AXEnabled");
            let focused = get_bool(el, "AXFocused");

            nodes.push(AXNode {
                uid,
                role,
                label,
                value,
                description: None,
                bounds,
                enabled,
                focused,
                children: vec![], // no children — keeps response slim
            });
        });
        core_foundation::base::CFRelease(app as _);
    }

    Ok((nodes, refs))
}

// ──────────────────────────────────────────────────────────────────────────────
// Public: ax_get_focused — get the currently focused element
// ──────────────────────────────────────────────────────────────────────────────

/// Return a single slim AXNode for the system-wide focused element and register
/// it in the returned refs map.  Returns `None` when nothing is focused.
///
/// This is the cheapest possible AX query — no tree walk at all.
pub fn ax_get_focused(
    generation: u64,
) -> Result<Option<(AXNode, HashMap<u32, AXRef>)>, String> {
    let system_wide = unsafe { AXUIElementCreateSystemWide() };
    if system_wide.is_null() {
        return Err("AXUIElementCreateSystemWide failed".into());
    }

    let attr = CFString::new("AXFocusedUIElement");
    let mut val: core_foundation::base::CFTypeRef = ptr::null();
    let ret = unsafe { AXUIElementCopyAttributeValue(system_wide, attr.as_concrete_TypeRef(), &mut val) };
    unsafe { core_foundation::base::CFRelease(system_wide as _); }

    if ret != K_AX_ERROR_OK || val.is_null() {
        return Ok(None);
    }

    let el = val as AXUIElementRef;
    // `val` is a +1 create rule result (CopyAttributeValue = create rule)
    let ax_ref = unsafe { AXRef::from_create(el) };
    let raw = ax_ref.as_raw();

    let role   = unsafe { get_string(raw, "AXRole") }.unwrap_or_else(|| "unknown".into());
    let label  = unsafe { get_string(raw, "AXTitle") }.or_else(|| unsafe { get_string(raw, "AXDescription") });
    let value  = unsafe { get_string(raw, "AXValue") };
    let bounds = unsafe { element_bbox(raw) };
    let enabled = unsafe { get_bool(raw, "AXEnabled") };
    let focused = Some(true);

    let mut refs: HashMap<u32, AXRef> = HashMap::new();
    refs.insert(0, ax_ref);

    let node = AXNode {
        uid: format!("a0g{generation}"),
        role,
        label,
        value,
        description: None,
        bounds,
        enabled,
        focused,
        children: vec![],
    };

    Ok(Some((node, refs)))
}

// ──────────────────────────────────────────────────────────────────────────────
// Public: dispatch actions on retained AXRef
// ──────────────────────────────────────────────────────────────────────────────

pub fn ax_perform_action(ax: &AXRef, action: &str) -> Result<(), String> {
    let attr = CFString::new(action);
    let ret = unsafe { AXUIElementPerformAction(ax.as_raw(), attr.as_concrete_TypeRef()) };
    if ret == K_AX_ERROR_OK { Ok(()) }
    else { Err(format!("AXUIElementPerformAction({action}) error {ret}")) }
}

pub fn ax_set_string(ax: &AXRef, attribute: &str, value: &str) -> Result<(), String> {
    let attr = CFString::new(attribute);
    let val  = CFString::new(value);
    let ret = unsafe {
        AXUIElementSetAttributeValue(ax.as_raw(), attr.as_concrete_TypeRef(), val.as_CFTypeRef())
    };
    if ret == K_AX_ERROR_OK { Ok(()) }
    else { Err(format!("AXSetAttributeValue({attribute}) error {ret}")) }
}

pub fn ax_click(ax: &AXRef) -> Result<(), String> {
    ax_perform_action(ax, "AXPress")
}

pub fn ax_set_value(ax: &AXRef, value: &str) -> Result<(), String> {
    ax_set_string(ax, "AXValue", value)
}

pub fn ax_select(ax: &AXRef) -> Result<(), String> {
    ax_perform_action(ax, "AXShowMenu")
        .or_else(|_| ax_perform_action(ax, "AXPick"))
}

// ──────────────────────────────────────────────────────────────────────────────
// Public: raise window
// ──────────────────────────────────────────────────────────────────────────────

/// Raise window(s) belonging to `pid` via AXRaise (works for bundle-less apps).
pub fn raise_windows(pid: i32) -> Result<(), String> {
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() { return Err(format!("AXUIElementCreateApplication failed for pid {pid}")); }

    // Get AXWindows array
    let attr = CFString::new("AXWindows");
    let mut val: core_foundation::base::CFTypeRef = ptr::null();
    let ret = unsafe { AXUIElementCopyAttributeValue(app, attr.as_concrete_TypeRef(), &mut val) };
    if ret != K_AX_ERROR_OK || val.is_null() {
        unsafe { core_foundation::base::CFRelease(app as _); }
        return Ok(()); // no windows
    }

    let windows: CFArray<*const c_void> = unsafe { CFArray::wrap_under_create_rule(val as _) };
    for i in 0..windows.len() {
        let w = unsafe { *windows.get_unchecked(i) } as AXUIElementRef;
        let action = CFString::new("AXRaise");
        unsafe { AXUIElementPerformAction(w, action.as_concrete_TypeRef()); }
    }
    unsafe { core_foundation::base::CFRelease(app as _); }
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers — PID lookup
// ──────────────────────────────────────────────────────────────────────────────

pub fn pid_for_window(window_id: u32) -> Result<i32, String> {
    use super::window::find_window_by_id_direct;
    let w = find_window_by_id_direct(window_id)?
        .ok_or_else(|| format!("Window {window_id} not found"))?;
    Ok(w.owner_pid as i32)
}

pub fn frontmost_pid() -> Result<i32, String> {
    unsafe {
        use cocoa::base::{id, nil};
        use objc::{class, msg_send, sel, sel_impl};
        let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        let app: id = msg_send![ws, frontmostApplication];
        if app == nil { return Err("No frontmost app".into()); }
        let pid: i32 = msg_send![app, processIdentifier];
        Ok(pid)
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers — AX attribute accessors
// ──────────────────────────────────────────────────────────────────────────────

unsafe fn ax_children(el: AXUIElementRef) -> Option<CFArray<*const c_void>> {
    let attr = CFString::new("AXChildren");
    let mut val: core_foundation::base::CFTypeRef = ptr::null();
    let ret = AXUIElementCopyAttributeValue(el, attr.as_concrete_TypeRef(), &mut val);
    if ret != K_AX_ERROR_OK || val.is_null() { return None; }
    Some(CFArray::wrap_under_create_rule(val as _))
}

unsafe fn get_string(el: AXUIElementRef, attr_name: &str) -> Option<String> {
    let attr = CFString::new(attr_name);
    let mut val: core_foundation::base::CFTypeRef = ptr::null();
    let ret = AXUIElementCopyAttributeValue(el, attr.as_concrete_TypeRef(), &mut val);
    if ret != K_AX_ERROR_OK || val.is_null() { return None; }
    CFType::wrap_under_create_rule(val)
        .downcast_into::<CFString>()
        .map(|s| s.to_string())
}

unsafe fn get_bool(el: AXUIElementRef, attr_name: &str) -> Option<bool> {
    let attr = CFString::new(attr_name);
    let mut val: core_foundation::base::CFTypeRef = ptr::null();
    let ret = AXUIElementCopyAttributeValue(el, attr.as_concrete_TypeRef(), &mut val);
    if ret != K_AX_ERROR_OK || val.is_null() { return None; }
    CFType::wrap_under_create_rule(val)
        .downcast_into::<CFBoolean>()
        .map(bool::from)
}

unsafe fn get_ax_value<T: Copy + Default>(el: AXUIElementRef, attr: &str, ty: u32) -> Option<T> {
    let cf_attr = CFString::new(attr);
    let mut val: core_foundation::base::CFTypeRef = ptr::null();
    let ret = AXUIElementCopyAttributeValue(el, cf_attr.as_concrete_TypeRef(), &mut val);
    if ret != K_AX_ERROR_OK || val.is_null() { return None; }
    let _owned = CFType::wrap_under_create_rule(val); // release on drop
    let mut out = T::default();
    let ok = AXValueGetValue(val as AXValueRef, ty, &mut out as *mut T as *mut c_void);
    if ok { Some(out) } else { None }
}

unsafe fn position_and_size(el: AXUIElementRef) -> Option<(CGPoint, CGSize)> {
    let pos:  CGPoint = get_ax_value(el, "AXPosition", K_AX_VALUE_CGPOINT)?;
    let size: CGSize  = get_ax_value(el, "AXSize",     K_AX_VALUE_CGSIZE)?;
    Some((pos, size))
}

pub(crate) unsafe fn element_bbox(el: AXUIElementRef) -> Option<Rect> {
    let (pos, sz) = position_and_size(el)?;
    Some(Rect { x: pos.x, y: pos.y, width: sz.width, height: sz.height })
}

// ──────────────────────────────────────────────────────────────────────────────
// Tree walk
// ──────────────────────────────────────────────────────────────────────────────

unsafe fn walk_tree(
    el: AXUIElementRef,
    count: &mut usize,
    depth: u32,
    visitor: &mut dyn FnMut(AXUIElementRef),
) {
    if depth > MAX_DEPTH || *count >= MAX_ELEMENTS { return; }
    *count += 1;
    visitor(el);
    if let Some(kids) = ax_children(el) {
        for i in 0..kids.len() {
            let child = *kids.get_unchecked(i) as AXUIElementRef;
            core_foundation::base::CFRetain(child as _);
            walk_tree(child, count, depth + 1, visitor);
            core_foundation::base::CFRelease(child as _);
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Window resize / move
// ──────────────────────────────────────────────────────────────────────────────

/// Move and/or resize the main window of the application with the given PID.
///
/// Pass `None` for any dimension you do not want to change.
pub fn resize_window_by_pid(
    pid: i32,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    unsafe {
        let app_el = AXUIElementCreateApplication(pid);
        if app_el.is_null() {
            return Err(format!("Could not create AX element for PID {pid}"));
        }

        // Get main window
        let attr_win = CFString::new("AXMainWindow");
        let mut win_ref: core_foundation::base::CFTypeRef = ptr::null_mut();
        let err = AXUIElementCopyAttributeValue(app_el, attr_win.as_concrete_TypeRef(), &mut win_ref);
        core_foundation::base::CFRelease(app_el as _);

        if err != K_AX_ERROR_OK || win_ref.is_null() {
            return Err(format!("Could not get main window for PID {pid} (AX error {err})"));
        }
        let win_el = win_ref as AXUIElementRef;

        // Set position if requested
        if let (Some(px), Some(py)) = (x, y) {
            let point = CGPoint { x: px, y: py };
            let val = AXValueCreate(K_AX_VALUE_CGPOINT, &point as *const _ as *const c_void);
            if !val.is_null() {
                let attr = CFString::new("AXPosition");
                AXUIElementSetAttributeValue(win_el, attr.as_concrete_TypeRef(), val as _);
                core_foundation::base::CFRelease(val as _);
            }
        }

        // Set size if requested
        if let (Some(w), Some(h)) = (width, height) {
            let sz = CGSize { width: w, height: h };
            let val = AXValueCreate(K_AX_VALUE_CGSIZE, &sz as *const _ as *const c_void);
            if !val.is_null() {
                let attr = CFString::new("AXSize");
                AXUIElementSetAttributeValue(win_el, attr.as_concrete_TypeRef(), val as _);
                core_foundation::base::CFRelease(val as _);
            }
        }

        core_foundation::base::CFRelease(win_el as _);
    }
    Ok(())
}
