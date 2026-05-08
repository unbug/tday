// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Linux mouse and keyboard input using X11 XTest.

use std::thread;
use std::time::Duration;
use x11::xlib::{Display, XCloseDisplay, XFlush, XOpenDisplay};
use x11::xtest::{
    XTestFakeButtonEvent, XTestFakeKeyEvent, XTestFakeMotionEvent,
};

#[derive(Debug, Clone, Copy, Default)]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Center,
}

impl MouseButton {
    fn to_x11(self) -> u32 {
        match self {
            MouseButton::Left   => 1,
            MouseButton::Right  => 3,
            MouseButton::Center => 2,
        }
    }
}

struct XConn(*mut Display);
impl Drop for XConn { fn drop(&mut self) { unsafe { XCloseDisplay(self.0); } } }

fn open_display() -> Result<XConn, String> {
    let dpy = unsafe { XOpenDisplay(std::ptr::null()) };
    if dpy.is_null() {
        Err("XOpenDisplay failed – is DISPLAY set?".to_string())
    } else {
        Ok(XConn(dpy))
    }
}

pub fn check_accessibility() -> bool {
    open_display().is_ok()
}

pub fn move_mouse(x: f64, y: f64) -> Result<(), String> {
    let conn = open_display()?;
    unsafe {
        XTestFakeMotionEvent(conn.0, -1, x as i32, y as i32, 0);
        XFlush(conn.0);
    }
    Ok(())
}

pub fn click(x: f64, y: f64, button: MouseButton, click_count: u32) -> Result<(), String> {
    move_mouse(x, y)?;
    thread::sleep(Duration::from_millis(10));
    let conn = open_display()?;
    let btn = button.to_x11();
    for i in 0..click_count {
        unsafe {
            XTestFakeButtonEvent(conn.0, btn, 1, 0); // press
            XTestFakeButtonEvent(conn.0, btn, 0, 0); // release
            XFlush(conn.0);
        }
        if i < click_count - 1 {
            thread::sleep(Duration::from_millis(50));
        }
    }
    Ok(())
}

pub fn drag(
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    button: MouseButton,
) -> Result<(), String> {
    let btn = button.to_x11();
    move_mouse(start_x, start_y)?;
    thread::sleep(Duration::from_millis(10));

    let conn = open_display()?;
    unsafe {
        XTestFakeButtonEvent(conn.0, btn, 1, 0);
        XFlush(conn.0);
    }
    thread::sleep(Duration::from_millis(10));

    for i in 1..=10 {
        let t = i as f64 / 10.0;
        let cx = start_x + (end_x - start_x) * t;
        let cy = start_y + (end_y - start_y) * t;
        unsafe { XTestFakeMotionEvent(conn.0, -1, cx as i32, cy as i32, 0); XFlush(conn.0); }
        thread::sleep(Duration::from_millis(10));
    }

    unsafe {
        XTestFakeButtonEvent(conn.0, btn, 0, 0);
        XFlush(conn.0);
    }
    Ok(())
}

pub fn scroll(x: f64, y: f64, delta_x: i32, delta_y: i32) -> Result<(), String> {
    move_mouse(x, y)?;
    thread::sleep(Duration::from_millis(10));
    let conn = open_display()?;
    // X11: button 4=up 5=down 6=left 7=right
    let (up_btn, down_btn) = (4u32, 5u32);
    let (left_btn, right_btn) = (6u32, 7u32);

    let press_button = |dpy: *mut Display, btn: u32, times: u32| {
        for _ in 0..times {
            unsafe {
                XTestFakeButtonEvent(dpy, btn, 1, 0);
                XTestFakeButtonEvent(dpy, btn, 0, 0);
            }
        }
    };

    if delta_y > 0 {
        press_button(conn.0, down_btn, delta_y as u32);
    } else if delta_y < 0 {
        press_button(conn.0, up_btn, (-delta_y) as u32);
    }
    if delta_x > 0 {
        press_button(conn.0, right_btn, delta_x as u32);
    } else if delta_x < 0 {
        press_button(conn.0, left_btn, (-delta_x) as u32);
    }

    unsafe { XFlush(conn.0); }
    Ok(())
}

pub fn get_cursor_position() -> Result<(f64, f64), String> {
    use x11::xlib::{
        XDefaultRootWindow, XQueryPointer, XWindowAttributes,
    };
    let conn = open_display()?;
    unsafe {
        let root = XDefaultRootWindow(conn.0);
        let mut root_ret = 0usize as x11::xlib::Window;
        let mut child_ret = 0usize as x11::xlib::Window;
        let (mut root_x, mut root_y) = (0i32, 0i32);
        let (mut win_x, mut win_y) = (0i32, 0i32);
        let mut mask = 0u32;
        XQueryPointer(
            conn.0, root, &mut root_ret, &mut child_ret,
            &mut root_x, &mut root_y, &mut win_x, &mut win_y, &mut mask,
        );
        Ok((root_x as f64, root_y as f64))
    }
}

pub fn press_key(key: &str, modifiers: &[String]) -> Result<(), String> {
    let conn = open_display()?;
    let keysym = key_name_to_keysym(key)
        .ok_or_else(|| format!("Unknown key: {key}"))?;

    let mod_keysyms: Vec<u64> = modifiers
        .iter()
        .filter_map(|m| mod_name_to_keysym(m))
        .collect();

    unsafe {
        use x11::xlib::{XKeysymToKeycode, XSync};
        // Press modifiers
        for &ksym in &mod_keysyms {
            let kc = XKeysymToKeycode(conn.0, ksym);
            if kc != 0 { XTestFakeKeyEvent(conn.0, kc as u32, 1, 0); }
        }
        // Press main key
        let kc = XKeysymToKeycode(conn.0, keysym);
        if kc == 0 { return Err(format!("No keycode for '{key}'")); }
        XTestFakeKeyEvent(conn.0, kc as u32, 1, 0);
        thread::sleep(Duration::from_millis(10));
        XTestFakeKeyEvent(conn.0, kc as u32, 0, 0);
        // Release modifiers in reverse
        for &ksym in mod_keysyms.iter().rev() {
            let kc2 = XKeysymToKeycode(conn.0, ksym);
            if kc2 != 0 { XTestFakeKeyEvent(conn.0, kc2 as u32, 0, 0); }
        }
        XFlush(conn.0);
    }
    Ok(())
}

pub fn type_text(text: &str) -> Result<(), String> {
    // Use xdotool for reliable Unicode typing if available, else fallback to XSendEvent
    let output = std::process::Command::new("xdotool")
        .args(["type", "--clearmodifiers", "--", text])
        .status();
    if output.map(|s| s.success()).unwrap_or(false) {
        return Ok(());
    }
    // Fallback: press each key using X11
    for c in text.chars() {
        let ks = (c as u64) | 0x01000000; // Unicode keysym prefix
        let conn = open_display()?;
        unsafe {
            use x11::xlib::{XKeysymToKeycode, XStringToKeysym};
            // Try direct Unicode keysym
            let kc = XKeysymToKeycode(conn.0, ks);
            if kc != 0 {
                XTestFakeKeyEvent(conn.0, kc as u32, 1, 0);
                XTestFakeKeyEvent(conn.0, kc as u32, 0, 0);
                XFlush(conn.0);
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

fn key_name_to_keysym(key: &str) -> Option<u64> {
    // Map common key names to X11 keysyms
    Some(match key.to_lowercase().as_str() {
        "return" | "enter"     => 0xFF0D,
        "tab"                  => 0xFF09,
        "space" | " "          => 0x0020,
        "delete" | "backspace" => 0xFF08,
        "forwarddelete"        => 0xFFFF,
        "escape" | "esc"       => 0xFF1B,
        "home"                 => 0xFF50,
        "left" | "leftarrow"   => 0xFF51,
        "up" | "uparrow"       => 0xFF52,
        "right" | "rightarrow" => 0xFF53,
        "down" | "downarrow"   => 0xFF54,
        "pageup" | "prior"     => 0xFF55,
        "pagedown" | "next"    => 0xFF56,
        "end"                  => 0xFF57,
        "insert"               => 0xFF63,
        "capslock"             => 0xFFE5,
        "shift" | "leftshift"  => 0xFFE1,
        "rightshift"           => 0xFFE2,
        "control" | "ctrl" | "leftcontrol" => 0xFFE3,
        "rightcontrol"         => 0xFFE4,
        "option" | "alt" | "leftalt" => 0xFFE9,
        "rightalt"             => 0xFFEA,
        "command" | "cmd" | "super" | "leftsuper" => 0xFFEB,
        "rightsuper"           => 0xFFEC,
        "f1"  => 0xFFBE, "f2"  => 0xFFBF, "f3"  => 0xFFC0, "f4"  => 0xFFC1,
        "f5"  => 0xFFC2, "f6"  => 0xFFC3, "f7"  => 0xFFC4, "f8"  => 0xFFC5,
        "f9"  => 0xFFC6, "f10" => 0xFFC7, "f11" => 0xFFC8, "f12" => 0xFFC9,
        "f13" => 0xFFCA, "f14" => 0xFFCB, "f15" => 0xFFCC, "f16" => 0xFFCD,
        "f17" => 0xFFCE, "f18" => 0xFFCF, "f19" => 0xFFD0, "f20" => 0xFFD1,
        s if s.len() == 1 => {
            let c = s.chars().next().unwrap();
            if c.is_ascii() { c as u64 } else { return None; }
        }
        _ => return None,
    })
}

fn mod_name_to_keysym(m: &str) -> Option<u64> {
    key_name_to_keysym(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_mapping() {
        assert!(key_name_to_keysym("return").is_some());
        assert!(key_name_to_keysym("f12").is_some());
        assert!(key_name_to_keysym("nonexistent_key_xyz").is_none());
    }
}
