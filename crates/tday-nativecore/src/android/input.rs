// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

//! Android touch input, text input, and key events via `adb shell input`.

use super::device::AndroidDevice;

/// Tap at (x, y) in screen pixels.
pub fn click(device: &mut AndroidDevice, x: f64, y: f64) -> Result<(), String> {
    device.shell_args(&["input", "tap", &x.to_string(), &y.to_string()])?;
    Ok(())
}

/// Swipe from (start_x, start_y) to (end_x, end_y) over `duration_ms` milliseconds.
pub fn swipe(
    device: &mut AndroidDevice,
    start_x: f64,
    start_y: f64,
    end_x: f64,
    end_y: f64,
    duration_ms: Option<u32>,
) -> Result<(), String> {
    let sx = start_x.to_string();
    let sy = start_y.to_string();
    let ex = end_x.to_string();
    let ey = end_y.to_string();
    let mut cmd = vec!["input", "swipe", &sx, &sy, &ex, &ey];
    let ms_str;
    if let Some(ms) = duration_ms {
        ms_str = ms.to_string();
        cmd.push(&ms_str);
    }
    device.shell_args(&cmd)?;
    Ok(())
}

/// Type text via `adb shell input text`. Special characters are escaped.
pub fn type_text(device: &mut AndroidDevice, text: &str) -> Result<(), String> {
    let escaped = escape_for_input(text);
    device.shell_args(&["input", "text", &escaped])?;
    Ok(())
}

/// Send a key event by key code name (e.g. `"KEYCODE_HOME"`, `"KEYCODE_BACK"`).
///
/// Only `KEYCODE_*` constants (strictly `[A-Z0-9_]` after the `KEYCODE_` prefix)
/// are accepted.  Unrecognised values are rejected to prevent shell injection.
pub fn press_key(device: &mut AndroidDevice, key: &str) -> Result<(), String> {
    let resolved = super::navigation::key_name_to_keycode(key);
    // Validate: must be KEYCODE_ followed only by uppercase letters, digits, or _.
    if !is_valid_keycode(&resolved) {
        return Err(format!(
            "Invalid key code '{key}': only KEYCODE_* constants are accepted"
        ));
    }
    device.shell_args(&["input", "keyevent", &resolved])?;
    Ok(())
}

/// Returns true if `s` is a valid Android KEYCODE_* constant.
fn is_valid_keycode(s: &str) -> bool {
    if let Some(suffix) = s.strip_prefix("KEYCODE_") {
        !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    } else {
        false
    }
}

/// Escape special shell characters for `adb shell input text`.
///
/// Spaces become `%s`; newlines/carriage-returns (which ADB shell treats as
/// command terminators) and all other shell metacharacters get a backslash prefix.
fn escape_for_input(text: &str) -> String {
    let mut result = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        match c {
            ' '  => result.push_str("%s"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\\' => result.push_str("\\\\"),
            '"'  => result.push_str("\\\""),
            '\'' => result.push_str("\\'"),
            '&'  => result.push_str("\\&"),
            '|'  => result.push_str("\\|"),
            ';'  => result.push_str("\\;"),
            '('  => result.push_str("\\("),
            ')'  => result.push_str("\\)"),
            '<'  => result.push_str("\\<"),
            '>'  => result.push_str("\\>"),
            '`'  => result.push_str("\\`"),
            '$'  => result.push_str("\\$"),
            '!'  => result.push_str("\\!"),
            _    => result.push(c),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_newline_and_carriage_return() {
        assert_eq!(escape_for_input("hello\nworld"), "hello\\nworld");
        assert_eq!(escape_for_input("a\rb"), "a\\rb");
    }

    #[test]
    fn escape_spaces() {
        assert_eq!(escape_for_input("hello world"), "hello%sworld");
    }

    #[test]
    fn escape_special_chars() {
        assert_eq!(escape_for_input("a&b"), "a\\&b");
        assert_eq!(escape_for_input("it's"), "it\\'s");
        assert_eq!(escape_for_input("a\"b"), "a\\\"b");
        assert_eq!(escape_for_input("a|b"), "a\\|b");
    }

    #[test]
    fn escape_plain_text_unchanged() {
        assert_eq!(escape_for_input("hello123"), "hello123");
    }

    #[test]
    fn escape_backslash() {
        assert_eq!(escape_for_input("a\\b"), "a\\\\b");
    }

    #[test]
    fn is_valid_keycode_accepts_known() {
        assert!(is_valid_keycode("KEYCODE_HOME"));
        assert!(is_valid_keycode("KEYCODE_ENTER"));
        assert!(is_valid_keycode("KEYCODE_1"));
    }

    #[test]
    fn is_valid_keycode_rejects_injection() {
        assert!(!is_valid_keycode("KEYCODE_HOME; rm -rf /"));
        assert!(!is_valid_keycode("HOME"));
        assert!(!is_valid_keycode("KEYCODE_"));
        assert!(!is_valid_keycode(""));
    }
}
