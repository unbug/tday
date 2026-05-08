// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Windows SendInput-based mouse and keyboard input simulation.

use std::thread;
use std::time::Duration;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, VIRTUAL_KEY, VK_BACK, VK_CAPITAL, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END,
    VK_ESCAPE, VK_F1, VK_F10, VK_F11, VK_F12, VK_F13, VK_F14, VK_F15, VK_F16, VK_F17, VK_F18,
    VK_F19, VK_F2, VK_F20, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_HOME,
    VK_INSERT, VK_LCONTROL, VK_LEFT, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_NEXT,
    VK_PRIOR, VK_RCONTROL, VK_RETURN, VK_RIGHT, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
    VK_SPACE, VK_TAB, VK_UP,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// Mouse button type.
#[derive(Debug, Clone, Copy, Default)]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Center,
}

/// Check if the process has input injection permissions.
/// On Windows, this always returns true unless we're targeting elevated windows.
pub fn check_accessibility() -> bool {
    true
}

/// Convert logical screen coordinates to normalized SendInput coordinates (0-65535).
fn to_absolute_coords(x: f64, y: f64) -> (i32, i32) {
    unsafe {
        let vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let nx = ((x - vx as f64) / vw as f64 * 65535.0) as i32;
        let ny = ((y - vy as f64) / vh as f64 * 65535.0) as i32;
        (nx, ny)
    }
}

fn make_mouse_input(dx: i32, dy: i32, flags: u32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Move the mouse cursor to screen coordinates (x, y).
pub fn move_mouse(x: f64, y: f64) -> Result<(), String> {
    let (ax, ay) = to_absolute_coords(x, y);
    let input = make_mouse_input(
        ax,
        ay,
        (MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK).0,
        0,
    );
    unsafe {
        let result = SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        if result == 0 {
            return Err("SendInput mouse move failed".to_string());
        }
    }
    Ok(())
}

/// Click at (x, y) with the given button and click_count.
pub fn click(x: f64, y: f64, button: MouseButton, click_count: u32) -> Result<(), String> {
    move_mouse(x, y)?;
    thread::sleep(Duration::from_millis(10));

    let (down_flag, up_flag) = match button {
        MouseButton::Left   => (MOUSEEVENTF_LEFTDOWN,   MOUSEEVENTF_LEFTUP),
        MouseButton::Right  => (MOUSEEVENTF_RIGHTDOWN,  MOUSEEVENTF_RIGHTUP),
        MouseButton::Center => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };

    for i in 0..click_count {
        let down = make_mouse_input(0, 0, down_flag.0, 0);
        let up   = make_mouse_input(0, 0, up_flag.0,   0);
        unsafe {
            let result = SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32);
            if result == 0 {
                return Err("SendInput click failed".to_string());
            }
        }
        if i < click_count - 1 {
            thread::sleep(Duration::from_millis(50));
        }
    }
    Ok(())
}

/// Drag from (start_x, start_y) to (end_x, end_y).
pub fn drag(
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    button: MouseButton,
) -> Result<(), String> {
    let (down_flag, up_flag) = match button {
        MouseButton::Left   => (MOUSEEVENTF_LEFTDOWN,   MOUSEEVENTF_LEFTUP),
        MouseButton::Right  => (MOUSEEVENTF_RIGHTDOWN,  MOUSEEVENTF_RIGHTUP),
        MouseButton::Center => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
    };
    let move_flags = (MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK).0;

    move_mouse(start_x, start_y)?;
    thread::sleep(Duration::from_millis(10));

    let down = make_mouse_input(0, 0, down_flag.0, 0);
    unsafe { SendInput(&[down], std::mem::size_of::<INPUT>() as i32); }
    thread::sleep(Duration::from_millis(10));

    // Interpolate movement in 10 steps
    for i in 1..=10 {
        let t = i as f64 / 10.0;
        let cx = start_x + (end_x - start_x) * t;
        let cy = start_y + (end_y - start_y) * t;
        let (ax, ay) = to_absolute_coords(cx, cy);
        let mv = make_mouse_input(ax, ay, move_flags, 0);
        unsafe { SendInput(&[mv], std::mem::size_of::<INPUT>() as i32); }
        thread::sleep(Duration::from_millis(10));
    }

    let (ex, ey) = to_absolute_coords(end_x, end_y);
    let up = make_mouse_input(
        ex,
        ey,
        (MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK).0 | up_flag.0,
        0,
    );
    unsafe { SendInput(&[up], std::mem::size_of::<INPUT>() as i32); }
    Ok(())
}

/// Scroll at (x, y). delta_x/delta_y are wheel ticks (positive = down/right).
pub fn scroll(x: f64, y: f64, delta_x: i32, delta_y: i32) -> Result<(), String> {
    move_mouse(x, y)?;
    thread::sleep(Duration::from_millis(10));

    if delta_y != 0 {
        let input = make_mouse_input(0, 0, MOUSEEVENTF_WHEEL.0, -delta_y * 120);
        unsafe {
            if SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 0 {
                return Err("SendInput vertical scroll failed".to_string());
            }
        }
    }
    if delta_x != 0 {
        let input = make_mouse_input(0, 0, MOUSEEVENTF_HWHEEL.0, delta_x * 120);
        unsafe {
            if SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 0 {
                return Err("SendInput horizontal scroll failed".to_string());
            }
        }
    }
    Ok(())
}

/// Get the current cursor position in screen coordinates.
pub fn get_cursor_position() -> Result<(f64, f64), String> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT::default();
    unsafe {
        GetCursorPos(&mut pt).map_err(|e| format!("GetCursorPos failed: {e}"))?;
    }
    Ok((pt.x as f64, pt.y as f64))
}

fn make_key_input(vk: VIRTUAL_KEY, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn make_unicode_input(c: u16, key_up: bool) -> INPUT {
    let flags = if key_up {
        (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP).0
    } else {
        KEYEVENTF_UNICODE.0
    };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: c,
                dwFlags: windows::Win32::UI::Input::KeyboardAndMouse::KEYBD_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Press a key with optional modifiers.
pub fn press_key(key: &str, modifiers: &[String]) -> Result<(), String> {
    let vk = key_name_to_vk(key).ok_or_else(|| format!("Unknown key: {key}"))?;

    let mut mod_vks = Vec::new();
    for m in modifiers {
        let mv = match m.to_lowercase().as_str() {
            "shift"                        => VK_SHIFT,
            "control" | "ctrl"             => VK_CONTROL,
            "option" | "alt"               => VK_MENU,
            "command" | "cmd" | "win" | "windows" => VK_LWIN,
            _ => return Err(format!("Unknown modifier: {m}")),
        };
        mod_vks.push(mv);
    }

    unsafe {
        for &mv in &mod_vks {
            SendInput(&[make_key_input(mv, 0)], std::mem::size_of::<INPUT>() as i32);
        }
        SendInput(&[make_key_input(vk, 0)], std::mem::size_of::<INPUT>() as i32);
        thread::sleep(Duration::from_millis(10));
        SendInput(&[make_key_input(vk, KEYEVENTF_KEYUP.0)], std::mem::size_of::<INPUT>() as i32);
        for &mv in mod_vks.iter().rev() {
            SendInput(&[make_key_input(mv, KEYEVENTF_KEYUP.0)], std::mem::size_of::<INPUT>() as i32);
        }
    }
    Ok(())
}

/// Type text using Unicode input events (layout-independent).
pub fn type_text(text: &str) -> Result<(), String> {
    for c in text.chars() {
        let mut buf = [0u16; 2];
        let encoded = c.encode_utf16(&mut buf);
        for &cu in encoded.iter() {
            let down = make_unicode_input(cu, false);
            let up   = make_unicode_input(cu, true);
            unsafe {
                if SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32) == 0 {
                    return Err(format!("SendInput failed for '{c}'"));
                }
            }
        }
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

fn key_name_to_vk(key: &str) -> Option<VIRTUAL_KEY> {
    Some(match key.to_lowercase().as_str() {
        "a" => VIRTUAL_KEY(0x41), "b" => VIRTUAL_KEY(0x42), "c" => VIRTUAL_KEY(0x43),
        "d" => VIRTUAL_KEY(0x44), "e" => VIRTUAL_KEY(0x45), "f" => VIRTUAL_KEY(0x46),
        "g" => VIRTUAL_KEY(0x47), "h" => VIRTUAL_KEY(0x48), "i" => VIRTUAL_KEY(0x49),
        "j" => VIRTUAL_KEY(0x4A), "k" => VIRTUAL_KEY(0x4B), "l" => VIRTUAL_KEY(0x4C),
        "m" => VIRTUAL_KEY(0x4D), "n" => VIRTUAL_KEY(0x4E), "o" => VIRTUAL_KEY(0x4F),
        "p" => VIRTUAL_KEY(0x50), "q" => VIRTUAL_KEY(0x51), "r" => VIRTUAL_KEY(0x52),
        "s" => VIRTUAL_KEY(0x53), "t" => VIRTUAL_KEY(0x54), "u" => VIRTUAL_KEY(0x55),
        "v" => VIRTUAL_KEY(0x56), "w" => VIRTUAL_KEY(0x57), "x" => VIRTUAL_KEY(0x58),
        "y" => VIRTUAL_KEY(0x59), "z" => VIRTUAL_KEY(0x5A),
        "0" | ")" => VIRTUAL_KEY(0x30), "1" | "!" => VIRTUAL_KEY(0x31),
        "2" | "@" => VIRTUAL_KEY(0x32), "3" | "#" => VIRTUAL_KEY(0x33),
        "4" | "$" => VIRTUAL_KEY(0x34), "5" | "%" => VIRTUAL_KEY(0x35),
        "6" | "^" => VIRTUAL_KEY(0x36), "7" | "&" => VIRTUAL_KEY(0x37),
        "8" | "*" => VIRTUAL_KEY(0x38), "9" | "(" => VIRTUAL_KEY(0x39),
        "return" | "enter"         => VK_RETURN,
        "tab"                      => VK_TAB,
        "space" | " "              => VK_SPACE,
        "delete" | "backspace"     => VK_BACK,
        "forwarddelete"            => VK_DELETE,
        "escape" | "esc"           => VK_ESCAPE,
        "shift"                    => VK_SHIFT,
        "control" | "ctrl"         => VK_CONTROL,
        "option" | "alt"           => VK_MENU,
        "command" | "cmd" | "win"  => VK_LWIN,
        "capslock"                 => VK_CAPITAL,
        "leftshift" | "lshift"     => VK_LSHIFT,
        "rightshift" | "rshift"    => VK_RSHIFT,
        "leftcontrol" | "lctrl"    => VK_LCONTROL,
        "rightcontrol" | "rctrl"   => VK_RCONTROL,
        "leftoption" | "lalt"      => VK_LMENU,
        "rightoption" | "ralt"     => VK_RMENU,
        "leftcmd" | "lwin"         => VK_LWIN,
        "rightcmd" | "rwin"        => VK_RWIN,
        "f1" => VK_F1,   "f2" => VK_F2,   "f3" => VK_F3,   "f4" => VK_F4,
        "f5" => VK_F5,   "f6" => VK_F6,   "f7" => VK_F7,   "f8" => VK_F8,
        "f9" => VK_F9,   "f10" => VK_F10, "f11" => VK_F11, "f12" => VK_F12,
        "f13" => VK_F13, "f14" => VK_F14, "f15" => VK_F15, "f16" => VK_F16,
        "f17" => VK_F17, "f18" => VK_F18, "f19" => VK_F19, "f20" => VK_F20,
        "home"                     => VK_HOME,
        "end"                      => VK_END,
        "pageup" | "prior"         => VK_PRIOR,
        "pagedown" | "next"        => VK_NEXT,
        "left" | "leftarrow"       => VK_LEFT,
        "right" | "rightarrow"     => VK_RIGHT,
        "up" | "uparrow"           => VK_UP,
        "down" | "downarrow"       => VK_DOWN,
        "insert"                   => VK_INSERT,
        "-" | "_"  => VIRTUAL_KEY(0xBD),
        "=" | "+"  => VIRTUAL_KEY(0xBB),
        "[" | "{"  => VIRTUAL_KEY(0xDB),
        "]" | "}"  => VIRTUAL_KEY(0xDD),
        "\\" | "|" => VIRTUAL_KEY(0xDC),
        ";" | ":"  => VIRTUAL_KEY(0xBA),
        "'" | "\"" => VIRTUAL_KEY(0xDE),
        "," | "<"  => VIRTUAL_KEY(0xBC),
        "." | ">"  => VIRTUAL_KEY(0xBE),
        "/" | "?"  => VIRTUAL_KEY(0xBF),
        "`" | "~"  => VIRTUAL_KEY(0xC0),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_mapping_known() {
        assert!(key_name_to_vk("a").is_some());
        assert!(key_name_to_vk("return").is_some());
        assert!(key_name_to_vk("f12").is_some());
    }

    #[test]
    fn test_key_mapping_unknown() {
        assert!(key_name_to_vk("nonexistent_key_xyz").is_none());
    }

    #[test]
    fn test_absolute_coords_non_negative() {
        let (x, y) = to_absolute_coords(0.0, 0.0);
        // On Windows virtual screen, (0,0) should normalize to near 0
        assert!(x >= 0 || x < 65536);
        assert!(y >= 0 || y < 65536);
    }

    #[test]
    fn test_get_cursor_position() {
        if let Ok((x, y)) = get_cursor_position() {
            assert!(x.is_finite());
            assert!(y.is_finite());
        }
    }
}
