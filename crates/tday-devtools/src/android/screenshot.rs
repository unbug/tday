//! Android screenshot capture via ADB framebuffer or `screencap -p`.

use std::io::Cursor;

use super::device::AndroidDevice;

/// Raw PNG screenshot from an Android device.
pub struct AndroidScreenshot {
    pub png_data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Capture a screenshot. Tries the ADB framebuffer first; falls back to
/// `adb shell screencap -p` if the framebuffer API returns an error.
pub fn capture(device: &mut AndroidDevice) -> Result<AndroidScreenshot, String> {
    let png_data = match device.framebuffer_png() {
        Ok(data) if !data.is_empty() => data,
        Ok(_) | Err(_) => {
            tracing::debug!("Framebuffer capture failed, falling back to screencap");
            let mut data = Vec::new();
            device
                .shell_bytes(&["screencap", "-p"], &mut data)
                .map_err(|e| format!("screencap fallback also failed: {e}"))?;
            if data.is_empty() {
                return Err("screencap returned empty output".to_string());
            }
            data
        }
    };

    let (width, height) = png_dimensions(&png_data).unwrap_or((0, 0));
    Ok(AndroidScreenshot { png_data, width, height })
}

fn png_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    use image::ImageReader;
    ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_dimensions_invalid_returns_none() {
        assert_eq!(png_dimensions(b"not a png"), None);
    }

    #[test]
    fn png_dimensions_empty_returns_none() {
        assert_eq!(png_dimensions(b""), None);
    }
}
