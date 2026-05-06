//! Screen recording: captures the frontmost app's window at a configurable
//! frame rate (default 5fps), writing timestamped JPEG frames to an output directory.

use serde::Serialize;
use std::path::{Path, PathBuf};
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

/// Metadata for a single recorded frame.
#[derive(Debug, Clone, Serialize)]
pub struct RecordedFrame {
    pub timestamp_ms: u64,
    pub path: String,
    pub app_name: String,
    pub window_id: u32,
    pub origin_x: f64,
    pub origin_y: f64,
    pub scale: f64,
    pub pixel_width: u32,
    pub pixel_height: u32,
}

/// Active screen recording session.
pub struct ScreenRecorder {
    frames: Arc<Mutex<Vec<RecordedFrame>>>,
    task_handle: JoinHandle<()>,
    cancel: CancellationToken,
}

impl ScreenRecorder {
    pub fn new(
        frames: Arc<Mutex<Vec<RecordedFrame>>>,
        task_handle: JoinHandle<()>,
        cancel: CancellationToken,
    ) -> Self {
        Self { frames, task_handle, cancel }
    }

    #[allow(dead_code)]
    pub fn is_finished(&self) -> bool {
        self.task_handle.is_finished()
    }

    #[allow(dead_code)]
    pub fn drain_frames(&self) -> Vec<RecordedFrame> {
        let mut frames = self.frames.lock().unwrap();
        frames.drain(..).collect()
    }

    pub async fn cancel_and_drain(mut self) -> Vec<RecordedFrame> {
        self.cancel.cancel();
        if tokio::time::timeout(std::time::Duration::from_secs(2), &mut self.task_handle)
            .await
            .is_err()
        {
            self.task_handle.abort();
        }
        self.cancel = CancellationToken::new();
        let mut buf = self.frames.lock().unwrap();
        buf.drain(..).collect()
    }
}

impl Drop for ScreenRecorder {
    fn drop(&mut self) {
        if !self.cancel.is_cancelled() && !self.task_handle.is_finished() {
            tracing::warn!(
                "ScreenRecorder dropped without stop_recording — cancelling background task"
            );
            self.cancel.cancel();
            self.task_handle.abort();
        }
    }
}

/// Start the screen recording background task.
pub fn start_recording(
    frames: Arc<Mutex<Vec<RecordedFrame>>>,
    cancel: CancellationToken,
    output_dir: PathBuf,
    fps: u32,
    max_duration_ms: u32,
) -> JoinHandle<()> {
    let fps = fps.clamp(1, 30);
    tokio::spawn(async move {
        let start = Instant::now();
        let max_duration = std::time::Duration::from_millis(max_duration_ms as u64);
        let tick_interval = std::time::Duration::from_millis(1000 / fps as u64);

        let mut interval = tokio::time::interval(tick_interval);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let mut app_name_cache: std::collections::HashMap<i32, String> =
            std::collections::HashMap::new();
        let output_dir: Arc<Path> = Arc::from(output_dir.as_path());

        loop {
            interval.tick().await;

            if cancel.is_cancelled() || start.elapsed() >= max_duration {
                return;
            }

            let app_cache_snapshot = app_name_cache.clone();
            let dir = output_dir.clone();

            let result = tokio::task::spawn_blocking(move || {
                capture_frontmost_frame(&app_cache_snapshot, &dir)
            })
            .await;

            match result {
                Ok(Ok((frame, pid, app_name))) => {
                    app_name_cache.insert(pid, app_name);
                    frames.lock().unwrap().push(frame);
                }
                Ok(Err(e)) => {
                    tracing::debug!("Frame capture failed: {e}");
                }
                Err(e) => {
                    tracing::debug!("Frame capture task panicked: {e}");
                }
            }
        }
    })
}

/// Capture a single frame from the frontmost app's window.
fn capture_frontmost_frame(
    app_name_cache: &std::collections::HashMap<i32, String>,
    output_dir: &Path,
) -> Result<(RecordedFrame, i32, String), String> {
    #[cfg(target_os = "macos")]
    {
        let windows = crate::platform::list_windows()
            .map_err(|e| format!("Failed to list windows: {e}"))?;
        let win = windows
            .iter()
            .find(|w| w.layer == 0)
            .ok_or_else(|| "No layer-0 window found".to_string())?;

        let window_id = win.id;
        let pid = win.owner_pid as i32;
        let app_name = app_name_cache
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| win.owner_name.clone());

        let timestamp_ms = now_millis();
        let (jpeg_data, origin_x, origin_y, scale, pixel_width, pixel_height) =
            crate::platform::capture_window_cg_jpeg(window_id)
                .map_err(|e| format!("Capture failed: {e}"))?;

        let filename = format!("frame_{timestamp_ms}.jpg");
        let path = output_dir.join(&filename);
        std::fs::write(&path, &jpeg_data)
            .map_err(|e| format!("Failed to write frame: {e}"))?;

        Ok((
            RecordedFrame {
                timestamp_ms,
                path: path.to_string_lossy().to_string(),
                app_name: app_name.clone(),
                window_id,
                origin_x,
                origin_y,
                scale,
                pixel_width,
                pixel_height,
            },
            pid,
            app_name,
        ))
    }

    #[cfg(not(any(target_os = "macos")))]
    {
        let _ = (app_name_cache, output_dir);
        Err("Screen recording is only supported on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_recorded_frame_serialization() {
        let frame = RecordedFrame {
            timestamp_ms: 1710400000000,
            path: "/tmp/frame_1710400000000.jpg".to_string(),
            app_name: "Finder".to_string(),
            window_id: 42,
            origin_x: 100.0,
            origin_y: 200.0,
            scale: 2.0,
            pixel_width: 1920,
            pixel_height: 1080,
        };
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"timestamp_ms\":1710400000000"));
        assert!(json.contains("\"app_name\":\"Finder\""));
        assert!(json.contains("\"window_id\":42"));
    }
}
