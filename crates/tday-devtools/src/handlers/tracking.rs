//! Hover tracking and screen recording handlers.

use crate::tracking::{HoverTracker, ScreenRecorder, start_polling, start_recording};
use rmcp::model::{CallToolResult, Content};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

pub type SharedHoverTracker = Arc<RwLock<Option<HoverTracker>>>;
pub type SharedScreenRecorder = Arc<RwLock<Option<ScreenRecorder>>>;

#[derive(Debug, Deserialize)]
pub struct StartHoverTrackingParams {
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_ms: u32,
    #[serde(default = "default_max_duration")]
    pub max_duration_ms: u32,
    #[serde(default = "default_min_dwell")]
    pub min_dwell_ms: u32,
}

fn default_poll_interval() -> u32 { 100 }
fn default_max_duration() -> u32 { 60_000 }
fn default_min_dwell() -> u32 { 200 }

#[derive(Debug, Deserialize)]
pub struct StartRecordingParams {
    pub output_dir: String,
    #[serde(default = "default_fps")]
    pub fps: u32,
    #[serde(default = "default_recording_max_duration")]
    pub max_duration_ms: u32,
}

fn default_fps() -> u32 { 5 }
fn default_recording_max_duration() -> u32 { 300_000 }

pub async fn start_hover_tracking(
    params: StartHoverTrackingParams,
    tracker: SharedHoverTracker,
) -> CallToolResult {
    // Cancel any existing tracking
    if let Some(existing) = tracker.write().await.take() {
        existing.cancel_and_drain().await;
    }

    let events = Arc::new(Mutex::new(Vec::new()));
    let cancel = CancellationToken::new();
    let task = start_polling(
        events.clone(),
        cancel.clone(),
        params.app_name.clone(),
        params.poll_interval_ms,
        params.max_duration_ms,
        params.min_dwell_ms,
    );

    *tracker.write().await = Some(HoverTracker::new(events, task, cancel));

    let msg = format!(
        "Hover tracking started (poll={}ms, max={}ms, min_dwell={}ms{})",
        params.poll_interval_ms,
        params.max_duration_ms,
        params.min_dwell_ms,
        params.app_name.as_deref().map(|a| format!(", app={a}")).unwrap_or_default()
    );
    CallToolResult::success(vec![Content::text(msg)])
}

pub async fn get_hover_events(tracker: SharedHoverTracker) -> CallToolResult {
    let guard = tracker.read().await;
    let Some(t) = guard.as_ref() else {
        return CallToolResult::error(vec![Content::text("Hover tracking not active. Use start_hover_tracking first.")]);
    };
    let events = t.drain_events();
    let finished = t.is_finished();
    drop(guard);

    let json = serde_json::json!({
        "events": events,
        "finished": finished,
    });
    CallToolResult::success(vec![Content::text(
        serde_json::to_string_pretty(&json).unwrap_or_default(),
    )])
}

pub async fn stop_hover_tracking(tracker: SharedHoverTracker) -> CallToolResult {
    if let Some(t) = tracker.write().await.take() {
        let events = t.cancel_and_drain().await;
        let json = serde_json::json!({
            "events": events,
            "stopped": true,
        });
        CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&json).unwrap_or_default(),
        )])
    } else {
        CallToolResult::error(vec![Content::text("Hover tracking not active.")])
    }
}

pub async fn start_recording_handler(
    params: StartRecordingParams,
    recorder: SharedScreenRecorder,
) -> CallToolResult {
    let output_dir = PathBuf::from(&params.output_dir);
    if let Err(e) = std::fs::create_dir_all(&output_dir) {
        return CallToolResult::error(vec![Content::text(format!(
            "Failed to create output dir: {e}"
        ))]);
    }

    // Cancel any existing recording
    if let Some(existing) = recorder.write().await.take() {
        existing.cancel_and_drain().await;
    }

    let frames = Arc::new(Mutex::new(Vec::new()));
    let cancel = CancellationToken::new();
    let task = start_recording(
        frames.clone(),
        cancel.clone(),
        output_dir.clone(),
        params.fps,
        params.max_duration_ms,
    );

    *recorder.write().await = Some(ScreenRecorder::new(frames, task, cancel));

    let msg = format!(
        "Recording started to '{}' (fps={}, max={}ms)",
        params.output_dir, params.fps, params.max_duration_ms
    );
    CallToolResult::success(vec![Content::text(msg)])
}

pub async fn stop_recording_handler(recorder: SharedScreenRecorder) -> CallToolResult {
    if let Some(r) = recorder.write().await.take() {
        let frames = r.cancel_and_drain().await;
        let json = serde_json::json!({
            "frames": frames,
            "count": frames.len(),
        });
        CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&json).unwrap_or_default(),
        )])
    } else {
        CallToolResult::error(vec![Content::text("No active recording.")])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_start_hover_defaults() {
        let json = serde_json::json!({});
        let params: StartHoverTrackingParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.poll_interval_ms, 100);
        assert_eq!(params.max_duration_ms, 60_000);
        assert_eq!(params.min_dwell_ms, 200);
    }

    #[test]
    fn test_start_recording_defaults() {
        let json = serde_json::json!({ "output_dir": "/tmp/rec" });
        let params: StartRecordingParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.fps, 5);
        assert_eq!(params.max_duration_ms, 300_000);
        assert_eq!(params.output_dir, "/tmp/rec");
    }
}
