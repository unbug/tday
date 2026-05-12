// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

//! Hover tracking state and event types.

use serde::Serialize;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A hover dwell event — emitted when the cursor leaves an element (or tracking ends).
#[derive(Debug, Clone, Serialize)]
pub struct HoverEvent {
    pub timestamp_ms: u64,
    pub cursor: CursorPosition,
    pub element: HoverElement,
    pub dwell_ms: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub timeout: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CursorPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct HoverElement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<ElementBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ElementBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Active hover tracking session.
pub struct HoverTracker {
    events: Arc<Mutex<Vec<HoverEvent>>>,
    task_handle: JoinHandle<()>,
    cancel: CancellationToken,
}

impl HoverTracker {
    pub fn new(
        events: Arc<Mutex<Vec<HoverEvent>>>,
        task_handle: JoinHandle<()>,
        cancel: CancellationToken,
    ) -> Self {
        Self { events, task_handle, cancel }
    }

    pub fn is_finished(&self) -> bool {
        self.task_handle.is_finished()
    }

    pub fn drain_events(&self) -> Vec<HoverEvent> {
        let mut events = self.events.lock().unwrap();
        events.drain(..).collect()
    }

    pub async fn cancel_and_drain(self) -> Vec<HoverEvent> {
        self.cancel.cancel();
        let Self { events, mut task_handle, .. } = self;
        if tokio::time::timeout(std::time::Duration::from_millis(500), &mut task_handle)
            .await
            .is_err()
        {
            task_handle.abort();
        }
        let mut buf = events.lock().unwrap();
        buf.drain(..).collect()
    }
}

const MAX_FIELD_LEN: usize = 100;

fn truncate_field(s: &str) -> String {
    if s.len() <= MAX_FIELD_LEN {
        s.to_string()
    } else {
        let mut end = MAX_FIELD_LEN;
        while !s.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}

pub fn parse_hover_element(value: &serde_json::Value) -> HoverElement {
    let str_field = |key: &str| -> Option<String> {
        value.get(key).and_then(|v| v.as_str()).map(truncate_field)
    };
    HoverElement {
        name: str_field("name"),
        role: str_field("role"),
        label: str_field("label"),
        bounds: value.get("bounds").map(|b| ElementBounds {
            x: b.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0),
            y: b.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0),
            width: b.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0),
            height: b.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0),
        }),
        app_name: str_field("app_name"),
        pid: value.get("pid").and_then(|v| v.as_i64()).map(|p| p as i32),
    }
}

pub fn elements_equal(a: &HoverElement, b: &HoverElement) -> bool {
    a.role == b.role && a.name == b.name && a.bounds == b.bounds
}

struct HoverEntry {
    element: HoverElement,
    since: Instant,
    enter_ms: u64,
    cursor: (f64, f64),
}

impl HoverEntry {
    fn into_event(self, left_at: Instant, timeout: bool) -> HoverEvent {
        HoverEvent {
            timestamp_ms: self.enter_ms,
            cursor: CursorPosition { x: self.cursor.0, y: self.cursor.1 },
            element: self.element,
            dwell_ms: left_at.duration_since(self.since).as_millis() as u64,
            timeout,
        }
    }
}

pub fn start_polling(
    events: Arc<Mutex<Vec<HoverEvent>>>,
    cancel: CancellationToken,
    app_name: Option<String>,
    poll_interval_ms: u32,
    max_duration_ms: u32,
    min_dwell_ms: u32,
) -> JoinHandle<()> {
    let app_name: Option<Arc<str>> = app_name.map(|s| Arc::from(s.as_str()));

    tokio::spawn(async move {
        let start = Instant::now();
        let max_duration = std::time::Duration::from_millis(max_duration_ms as u64);
        let poll_interval = std::time::Duration::from_millis(poll_interval_ms as u64);
        let min_dwell = std::time::Duration::from_millis(min_dwell_ms as u64);

        let mut confirmed: Option<HoverEntry> = None;
        let mut first_departure: Option<Instant> = None;
        let mut candidate: Option<HoverEntry> = None;

        loop {
            if cancel.is_cancelled() { return; }

            if start.elapsed() >= max_duration {
                if let Some(entry) = confirmed {
                    let left_at = first_departure.unwrap_or_else(Instant::now);
                    events.lock().unwrap().push(entry.into_event(left_at, true));
                }
                return;
            }

            let app = app_name.clone();
            let poll_result = tokio::task::spawn_blocking(move || {
                let cursor = get_cursor_position_sync()?;
                let element = element_at_point_for_hover(cursor.0, cursor.1, app.as_deref())?;
                Ok::<_, String>((cursor, element))
            })
            .await;

            let (cursor, current_element) = match poll_result {
                Ok(Ok(result)) => result,
                _ => {
                    tokio::time::sleep(poll_interval).await;
                    continue;
                }
            };

            let differs_from_confirmed = match &confirmed {
                Some(c) => !elements_equal(&c.element, &current_element),
                None => true,
            };

            if !differs_from_confirmed {
                candidate = None;
                first_departure = None;
                tokio::time::sleep(poll_interval).await;
                continue;
            }

            let cand_matches = candidate
                .as_ref()
                .is_some_and(|c| elements_equal(&c.element, &current_element));

            if cand_matches {
                let cand = candidate.as_ref().unwrap();
                if cand.since.elapsed() >= min_dwell {
                    if let Some(prev) = confirmed.take() {
                        let departed = first_departure.unwrap_or(cand.since);
                        events.lock().unwrap().push(prev.into_event(departed, false));
                    }
                    confirmed = candidate.take();
                    first_departure = None;
                }
            } else {
                if first_departure.is_none() && confirmed.is_some() {
                    first_departure = Some(Instant::now());
                }
                candidate = Some(HoverEntry {
                    element: current_element,
                    since: Instant::now(),
                    enter_ms: now_millis(),
                    cursor,
                });
            }

            tokio::time::sleep(poll_interval).await;
        }
    })
}

fn get_cursor_position_sync() -> Result<(f64, f64), String> {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        crate::platform::get_cursor_position()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Hover tracking is not supported on this platform".to_string())
    }
}

fn element_at_point_for_hover(
    x: f64,
    y: f64,
    app_name: Option<&str>,
) -> Result<HoverElement, String> {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let info = crate::platform::element_at_point(x, y, app_name)?;
        Ok(hover_element_from_info(info))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (x, y, app_name);
        Err("Hover tracking is not supported on this platform".to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn hover_element_from_info(info: crate::platform::ElementInfo) -> HoverElement {
    HoverElement {
        name:     info.name.map(|s| truncate_field(&s)),
        role:     info.role.map(|s| truncate_field(&s)),
        label:    info.description.map(|s| truncate_field(&s)),
        bounds:   info.bounds.map(|r| ElementBounds { x: r.x, y: r.y, width: r.width, height: r.height }),
        app_name: info.app_name.map(|s| truncate_field(&s)),
        pid:      Some(info.pid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_hover_element_full() {
        let json = serde_json::json!({
            "name": "File",
            "role": "AXMenuBarItem",
            "label": "File menu",
            "bounds": { "x": 100.0, "y": 200.0, "width": 40.0, "height": 22.0 },
            "app_name": "Finder",
            "pid": 1234
        });
        let el = parse_hover_element(&json);
        assert_eq!(el.name, Some("File".to_string()));
        assert_eq!(el.role, Some("AXMenuBarItem".to_string()));
        assert_eq!(el.label, Some("File menu".to_string()));
        assert_eq!(el.app_name, Some("Finder".to_string()));
        assert_eq!(el.pid, Some(1234));
        assert_eq!(
            el.bounds,
            Some(ElementBounds { x: 100.0, y: 200.0, width: 40.0, height: 22.0 })
        );
    }

    #[test]
    fn test_parse_hover_element_empty() {
        let json = serde_json::json!({});
        let el = parse_hover_element(&json);
        assert_eq!(el.name, None);
        assert_eq!(el.role, None);
        assert_eq!(el.bounds, None);
    }

    #[test]
    fn test_elements_equal() {
        let a = HoverElement {
            name: Some("File".into()),
            role: Some("AXMenuBarItem".into()),
            label: None,
            bounds: Some(ElementBounds { x: 10.0, y: 20.0, width: 30.0, height: 40.0 }),
            app_name: None,
            pid: None,
        };
        let b = a.clone();
        assert!(elements_equal(&a, &b));

        let c = HoverElement { name: Some("Edit".into()), ..a.clone() };
        assert!(!elements_equal(&a, &c));
    }

    #[test]
    fn test_truncate_field() {
        let s = "a".repeat(150);
        let truncated = truncate_field(&s);
        assert!(truncated.ends_with('…'));
        assert!(truncated.len() <= MAX_FIELD_LEN + 4); // "…" is 3 bytes
    }
}
