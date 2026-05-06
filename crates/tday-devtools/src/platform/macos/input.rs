/// CGEvent-based mouse and keyboard input simulation for macOS.

use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use std::thread;
use std::time::Duration;

// ──────────────────────────────────────────────────────────────────────────────
// Mouse
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default)]
pub enum MouseButton { #[default] Left, Right, Center }

impl MouseButton {
    fn cg(&self) -> CGMouseButton {
        match self { MouseButton::Left => CGMouseButton::Left, MouseButton::Right => CGMouseButton::Right, MouseButton::Center => CGMouseButton::Center }
    }
    fn events(&self) -> (CGEventType, CGEventType, CGEventType) {
        match self {
            MouseButton::Left   => (CGEventType::LeftMouseDown,  CGEventType::LeftMouseDragged,  CGEventType::LeftMouseUp),
            MouseButton::Right  => (CGEventType::RightMouseDown, CGEventType::RightMouseDragged, CGEventType::RightMouseUp),
            MouseButton::Center => (CGEventType::OtherMouseDown, CGEventType::OtherMouseDragged, CGEventType::OtherMouseUp),
        }
    }
}

pub fn move_mouse(x: f64, y: f64) -> Result<(), String> {
    let src = source()?;
    let ev = CGEvent::new_mouse_event(src, CGEventType::MouseMoved, CGPoint::new(x, y), CGMouseButton::Left)
        .map_err(|_| "create MouseMoved event failed")?;
    ev.post(CGEventTapLocation::HID);
    Ok(())
}

pub fn click(x: f64, y: f64, button: MouseButton, click_count: u32) -> Result<(), String> {
    let src = source()?;
    let pt = CGPoint::new(x, y);
    let (dn, _, up) = button.events();
    let cg = button.cg();

    for i in 0..click_count {
        let d = CGEvent::new_mouse_event(src.clone(), dn, pt, cg)
            .map_err(|_| "create MouseDown event failed")?;
        let u = CGEvent::new_mouse_event(src.clone(), up, pt, cg)
            .map_err(|_| "create MouseUp event failed")?;
        let n = (i + 1) as i64;
        d.set_integer_value_field(core_graphics::event::EventField::MOUSE_EVENT_CLICK_STATE, n);
        u.set_integer_value_field(core_graphics::event::EventField::MOUSE_EVENT_CLICK_STATE, n);
        d.post(CGEventTapLocation::HID);
        thread::sleep(Duration::from_millis(10));
        u.post(CGEventTapLocation::HID);
        if i < click_count - 1 { thread::sleep(Duration::from_millis(50)); }
    }
    Ok(())
}

pub fn drag(sx: f64, sy: f64, ex: f64, ey: f64, button: MouseButton) -> Result<(), String> {
    let src = source()?;
    let (dn, drag_ty, up) = button.events();
    let cg = button.cg();

    CGEvent::new_mouse_event(src.clone(), dn, CGPoint::new(sx, sy), cg)
        .map_err(|_| "MouseDown failed")?.post(CGEventTapLocation::HID);
    thread::sleep(Duration::from_millis(10));

    for i in 1..=10 {
        let t = i as f64 / 10.0;
        let cx = sx + (ex - sx) * t; let cy = sy + (ey - sy) * t;
        CGEvent::new_mouse_event(src.clone(), drag_ty, CGPoint::new(cx, cy), cg)
            .map_err(|_| "Drag event failed")?.post(CGEventTapLocation::HID);
        thread::sleep(Duration::from_millis(10));
    }

    CGEvent::new_mouse_event(src, up, CGPoint::new(ex, ey), cg)
        .map_err(|_| "MouseUp failed")?.post(CGEventTapLocation::HID);
    Ok(())
}

pub fn scroll(x: f64, y: f64, delta_x: i32, delta_y: i32) -> Result<(), String> {
    move_mouse(x, y)?;
    thread::sleep(Duration::from_millis(10));

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreateScrollWheelEvent(src: *const std::ffi::c_void, units: u32, wc: u32, w1: i32, w2: i32) -> *mut std::ffi::c_void;
        fn CGEventPost(tap: u32, ev: *mut std::ffi::c_void);
        fn CFRelease(cf: *mut std::ffi::c_void);
    }

    unsafe {
        let ev = CGEventCreateScrollWheelEvent(std::ptr::null(), 0, 2, delta_y, delta_x);
        if ev.is_null() { return Err("Create scroll event failed".into()); }
        CGEventPost(0, ev);
        CFRelease(ev);
    }
    Ok(())
}

pub fn get_cursor_position() -> Result<(f64, f64), String> {
    let src = source()?;
    let ev = CGEvent::new(src).map_err(|_| "Create event failed")?;
    let pt = ev.location();
    Ok((pt.x, pt.y))
}

// ──────────────────────────────────────────────────────────────────────────────
// Keyboard
// ──────────────────────────────────────────────────────────────────────────────

pub fn press_key(key: &str, modifiers: &[String]) -> Result<(), String> {
    let src = source()?;
    let kc = key_code(key).ok_or_else(|| format!("Unknown key: {key}"))?;
    let flags = build_flags(modifiers)?;

    let dn = CGEvent::new_keyboard_event(src.clone(), kc, true)
        .map_err(|_| "KeyDown event failed")?;
    dn.set_flags(flags);
    dn.post(CGEventTapLocation::HID);
    thread::sleep(Duration::from_millis(10));

    let up = CGEvent::new_keyboard_event(src, kc, false)
        .map_err(|_| "KeyUp event failed")?;
    up.set_flags(flags);
    up.post(CGEventTapLocation::HID);
    Ok(())
}

pub fn type_text(text: &str) -> Result<(), String> {
    let src = source()?;
    for ch in text.chars() {
        let needs_shift = ch.is_uppercase() || matches!(ch,
            '!'|'@'|'#'|'$'|'%'|'^'|'&'|'*'|'('|')'|'_'|'+'|'{'|'}'|'|'|':'|'"'|'<'|'>'|'?'|'~'
        );
        let lower = ch.to_lowercase().next().unwrap_or(ch).to_string();

        if let Some(kc) = key_code(&lower) {
            let mut flags = CGEventFlags::empty();
            if needs_shift { flags |= CGEventFlags::CGEventFlagShift; }

            let dn = CGEvent::new_keyboard_event(src.clone(), kc, true)
                .map_err(|_| "KeyDown failed")?;
            dn.set_flags(flags); dn.post(CGEventTapLocation::HID);
            thread::sleep(Duration::from_millis(5));
            let up = CGEvent::new_keyboard_event(src.clone(), kc, false)
                .map_err(|_| "KeyUp failed")?;
            up.set_flags(flags); up.post(CGEventTapLocation::HID);
        } else {
            // Fallback: Unicode string injection via key event
            let dn = CGEvent::new_keyboard_event(src.clone(), 0, true)
                .map_err(|_| "KeyDown failed")?;
            dn.set_string(&ch.to_string()); dn.post(CGEventTapLocation::HID);
            thread::sleep(Duration::from_millis(5));
            let up = CGEvent::new_keyboard_event(src.clone(), 0, false)
                .map_err(|_| "KeyUp failed")?;
            up.post(CGEventTapLocation::HID);
        }
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

#[allow(dead_code)]
pub fn check_accessibility() -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(opts: core_foundation::base::CFTypeRef) -> bool;
    }
    let key   = CFString::new("AXTrustedCheckOptionPrompt");
    let value = core_foundation::boolean::CFBoolean::false_value();
    let opts  = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(opts.as_concrete_TypeRef() as _) }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

fn source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "CGEventSource::new failed".to_string())
}

fn build_flags(modifiers: &[String]) -> Result<CGEventFlags, String> {
    let mut flags = CGEventFlags::empty();
    for m in modifiers {
        match m.to_lowercase().as_str() {
            "shift"               => flags |= CGEventFlags::CGEventFlagShift,
            "control" | "ctrl"    => flags |= CGEventFlags::CGEventFlagControl,
            "option"  | "alt"     => flags |= CGEventFlags::CGEventFlagAlternate,
            "command" | "cmd"     => flags |= CGEventFlags::CGEventFlagCommand,
            other => return Err(format!("Unknown modifier: {other}")),
        }
    }
    Ok(flags)
}

fn key_code(key: &str) -> Option<CGKeyCode> {
    Some(match key.to_lowercase().as_str() {
        // Letters
        "a"=>0x00,"s"=>0x01,"d"=>0x02,"f"=>0x03,"h"=>0x04,"g"=>0x05,
        "z"=>0x06,"x"=>0x07,"c"=>0x08,"v"=>0x09,"b"=>0x0B,"q"=>0x0C,
        "w"=>0x0D,"e"=>0x0E,"r"=>0x0F,"y"=>0x10,"t"=>0x11,
        "1"|"!"=>0x12,"2"|"@"=>0x13,"3"|"#"=>0x14,"4"|"$"=>0x15,
        "6"|"^"=>0x16,"5"|"%"=>0x17,"="| "+"=>0x18,"9"|"("=>0x19,
        "7"|"&"=>0x1A,"-"|"_"=>0x1B,"8"|"*"=>0x1C,"0"|")"=>0x1D,
        "]"|"}"=>0x1E,"o"=>0x1F,"u"=>0x20,"["|"{"=>0x21,"i"=>0x22,
        "p"=>0x23,"l"=>0x25,"j"=>0x26,"'"|"\""=>0x27,"k"=>0x28,
        ";"|":"=>0x29,"\\"|"|"=>0x2A,","|"<"=>0x2B,"/"|"?"=>0x2C,
        "n"=>0x2D,"m"=>0x2E,"."|">"=>0x2F,"`"|"~"=>0x32,
        // Special
        "return"|"enter"=>0x24,"tab"=>0x30,"space"|" "=>0x31,
        "delete"|"backspace"=>0x33,"escape"|"esc"=>0x35,
        "command"|"cmd"=>0x37,"shift"=>0x38,"capslock"=>0x39,
        "option"|"alt"=>0x3A,"control"|"ctrl"=>0x3B,
        "fn"|"function"=>0x3F,
        // Function
        "f1"=>0x7A,"f2"=>0x78,"f3"=>0x63,"f4"=>0x76,"f5"=>0x60,
        "f6"=>0x61,"f7"=>0x62,"f8"=>0x64,"f9"=>0x65,"f10"=>0x6D,
        "f11"=>0x67,"f12"=>0x6F,"f13"=>0x69,"f14"=>0x6B,"f15"=>0x71,
        "f16"=>0x6A,"f17"=>0x40,"f18"=>0x4F,"f19"=>0x50,"f20"=>0x5A,
        // Navigation
        "home"=>0x73,"end"=>0x77,"pageup"=>0x74,"pagedown"=>0x79,
        "left"|"leftarrow"=>0x7B,"right"|"rightarrow"=>0x7C,
        "down"|"downarrow"=>0x7D,"up"|"uparrow"=>0x7E,
        "forwarddelete"=>0x75,"help"=>0x72,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn known_keys_resolve() {
        assert!(key_code("a").is_some());
        assert!(key_code("return").is_some());
        assert!(key_code("f12").is_some());
        assert!(key_code("nonexistent_key").is_none());
    }
    #[test] fn cursor_position_ok() {
        get_cursor_position().expect("should get cursor position");
    }
}
