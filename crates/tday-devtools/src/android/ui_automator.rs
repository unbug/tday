//! Android UI Automator: parse `uiautomator dump` XML to find elements.

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::Serialize;

use super::device::AndroidDevice;

/// A UI element found in the UIAutomator hierarchy.
#[derive(Debug, Clone, Serialize)]
pub struct UiElement {
    /// Visible text or content-desc that matched the search query.
    pub text: String,
    /// Centre X of the element's bounding box (screen pixels).
    pub x: f64,
    /// Centre Y of the element's bounding box (screen pixels).
    pub y: f64,
    pub bounds: UiBounds,
}

/// Bounding box of a UI element.
#[derive(Debug, Clone, Serialize)]
pub struct UiBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

const DUMP_PATH: &str = "/sdcard/ui_dump.xml";

/// Result of a `find_text` search.
pub struct FindTextResult {
    pub matches: Vec<UiElement>,
    /// Populated when `matches` is empty; lists all visible element names to
    /// help the caller suggest corrections.
    pub available_elements: Vec<String>,
}

/// Find UI elements whose `text` or `content-desc` contains `search` (case-insensitive).
///
/// Tries `/dev/tty` first (fast, no file I/O). Falls back to writing a temp
/// file for Samsung and other OEMs that don't write to `/dev/tty`.
pub fn find_text(device: &mut AndroidDevice, search: &str) -> Result<FindTextResult, String> {
    let xml = dump_ui_xml(device)?;
    let matches = search_xml(&xml, search);
    let available_elements = if matches.is_empty() {
        collect_element_names(&xml)
    } else {
        Vec::new()
    };
    Ok(FindTextResult { matches, available_elements })
}

// ─── Internal helpers ────────────────────────────────────────────────────────

fn dump_ui_xml(device: &mut AndroidDevice) -> Result<String, String> {
    let output = device
        .shell("uiautomator dump /dev/tty")
        .map_err(|e| format!("uiautomator dump failed: {e}"))?;

    if let Some(start) = output.find('<') {
        return Ok(output[start..].to_string());
    }

    // Fallback: dump to file on device.
    let cmd = format!(
        "uiautomator dump {path} && cat {path} && rm -f {path}",
        path = DUMP_PATH
    );
    let output = device
        .shell(&cmd)
        .map_err(|e| format!("uiautomator dump (file fallback) failed: {e}"))?;

    let start = output.find('<').ok_or_else(|| {
        format!(
            "UI dump failed — device may be locked. Raw: {}",
            &output[..output.len().min(200)]
        )
    })?;
    Ok(output[start..].to_string())
}

/// Parse a bounds string `[x1,y1][x2,y2]` → `(x1, y1, x2, y2)`.
fn parse_bounds(s: &str) -> Option<(f64, f64, f64, f64)> {
    let parts: Vec<&str> = s.trim().split(']').collect();
    if parts.len() < 2 {
        return None;
    }
    let p1: Vec<&str> = parts[0].trim_start_matches('[').split(',').collect();
    let p2: Vec<&str> = parts[1].trim_start_matches('[').split(',').collect();
    if p1.len() != 2 || p2.len() != 2 {
        return None;
    }
    Some((
        p1[0].parse().ok()?,
        p1[1].parse().ok()?,
        p2[0].parse().ok()?,
        p2[1].parse().ok()?,
    ))
}

fn collect_element_names(xml: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Empty(ref e)) | Ok(Event::Start(ref e)) => {
                // Skip elements with zero-area bounds (invisible elements)
                let mut bounds_str = String::new();
                let mut text_val = String::new();
                let mut desc_val = String::new();
                for attr in e.attributes().flatten() {
                    let key = attr.key.as_ref();
                    if key == b"bounds" {
                        bounds_str = attr.unescape_value().unwrap_or_default().to_string();
                    } else if key == b"text" {
                        text_val = attr.unescape_value().unwrap_or_default().to_string();
                    } else if key == b"content-desc" {
                        desc_val = attr.unescape_value().unwrap_or_default().to_string();
                    }
                }
                // Filter zero-area bounds
                if let Some((x1, y1, x2, y2)) = parse_bounds(&bounds_str) {
                    if (x2 - x1).abs() < 1.0 || (y2 - y1).abs() < 1.0 {
                        continue;
                    }
                }
                for value in [text_val, desc_val] {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                        names.push(trimmed.to_string());
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    names
}

fn search_xml(xml: &str, search: &str) -> Vec<UiElement> {
    let needle = search.to_lowercase();
    let mut results = Vec::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Empty(ref e)) | Ok(Event::Start(ref e)) => {
                let mut text = String::new();
                let mut desc = String::new();
                let mut bounds = String::new();
                for attr in e.attributes().flatten() {
                    match attr.key.as_ref() {
                        b"text"        => text   = attr.unescape_value().unwrap_or_default().to_string(),
                        b"content-desc"=> desc   = attr.unescape_value().unwrap_or_default().to_string(),
                        b"bounds"      => bounds = attr.unescape_value().unwrap_or_default().to_string(),
                        _ => {}
                    }
                }
                let text_hit = !text.is_empty()   && text.to_lowercase().contains(&needle);
                let desc_hit = !desc.is_empty()   && desc.to_lowercase().contains(&needle);
                if (text_hit || desc_hit) && !bounds.is_empty() {
                    if let Some((x1, y1, x2, y2)) = parse_bounds(&bounds) {
                        let label = if text_hit { text } else { desc };
                        results.push(UiElement {
                            text: label,
                            x: (x1 + x2) / 2.0,
                            y: (y1 + y2) / 2.0,
                            bounds: UiBounds { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
                        });
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_XML: &str = r#"<?xml version="1.0"?>
<hierarchy rotation="0">
  <node text="Settings" content-desc="" bounds="[0,0][100,50]"/>
  <node text="" content-desc="Search button" bounds="[100,0][200,50]"/>
  <node text="Invisible" content-desc="" bounds="[0,0][0,0]"/>
</hierarchy>"#;

    #[test]
    fn parse_bounds_basic() {
        assert_eq!(parse_bounds("[10,20][110,70]"), Some((10.0, 20.0, 110.0, 70.0)));
    }

    #[test]
    fn parse_bounds_invalid() {
        assert!(parse_bounds("bad").is_none());
    }

    #[test]
    fn search_finds_text_attr() {
        let results = search_xml(SAMPLE_XML, "settings");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "Settings");
        assert_eq!(results[0].x, 50.0);
        assert_eq!(results[0].y, 25.0);
    }

    #[test]
    fn search_finds_content_desc() {
        let results = search_xml(SAMPLE_XML, "search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].text, "Search button");
    }

    #[test]
    fn search_case_insensitive() {
        let results = search_xml(SAMPLE_XML, "SETTINGS");
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn collect_names_excludes_empty() {
        let names = collect_element_names(SAMPLE_XML);
        assert!(names.contains(&"Settings".to_string()));
        assert!(names.contains(&"Search button".to_string()));
        assert!(!names.contains(&"Invisible".to_string()));
    }
}
