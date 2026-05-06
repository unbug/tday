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
pub fn press_key(device: &mut AndroidDevice, key: &str) -> Result<(), String> {
    device.shell_args(&["input", "keyevent", key])?;
    Ok(())
}

/// Escape special shell characters for `adb shell input text`.
///
/// Spaces become `%s`; shell metacharacters get a backslash prefix.
fn escape_for_input(text: &str) -> String {
    let mut result = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        match c {
            ' '  => result.push_str("%s"),
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
}
