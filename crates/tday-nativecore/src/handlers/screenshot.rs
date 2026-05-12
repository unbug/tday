// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

/// Screenshot + find_image MCP tool handlers.

use crate::error::{DevToolsError, Result};
use crate::find_image::{find_image as fi_find, ScreenshotMeta, SearchRegion};
use crate::platform;
use crate::session::screenshot_cache::{ScreenshotCache, ScreenshotMeta as CacheMeta};
use crate::session::image_cache::ImageCache;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

// ──────────────────────────────────────────────────────────────────────────────
// take_screenshot
// ──────────────────────────────────────────────────────────────────────────────

pub async fn handle_take_screenshot(
    params:    Value,
    ss_cache:  Arc<RwLock<ScreenshotCache>>,
) -> Result<Value> {
    let window_id: Option<u32> = params.get("window_id").and_then(|v| v.as_u64()).map(|v| v as u32);

    let (jpeg_bytes, png_data, origin_x, origin_y, scale, pw, ph) = tokio::task::spawn_blocking(move || {
        match window_id {
            Some(wid) => {
                let (jpeg, ox, oy, sc, pw, ph) = platform::capture_window_cg_jpeg(wid)?;
                // Decode JPEG once to get PNG for the cache
                let img = image::load_from_memory(&jpeg)
                    .map_err(|e| format!("jpeg→png: {e}"))?;
                let mut png = Vec::new();
                img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                    .map_err(|e| format!("png encode: {e}"))?;
                Ok::<_, String>((jpeg, png, ox, oy, sc, pw, ph))
            }
            None => {
                // Full screen: capture gives us PNG directly
                let ss = platform::capture_screen()
                    .map_err(|e| format!("capture_screen: {e}"))?;
                // Encode JPEG for sending to client
                let img = image::load_from_memory(&ss.png_data)
                    .map_err(|e| format!("decode: {e}"))?;
                let mut jpeg = Vec::new();
                img.write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
                    .map_err(|e| format!("jpeg: {e}"))?;
                Ok::<_, String>((jpeg, ss.png_data, ss.origin_x, ss.origin_y, ss.scale_factor,
                    ss.pixel_width, ss.pixel_height))
            }
        }
    }).await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Screenshot)?;

    let meta = CacheMeta { origin_x, origin_y, scale, window_id, pixel_width: pw, pixel_height: ph };
    let ss_id = ss_cache.write().await.store(png_data, meta);

    let b64 = B64.encode(&jpeg_bytes);
    Ok(json!({
        "screenshot_id": ss_id,
        "image_base64": b64,
        "image_format": "jpeg",
        "origin_x": origin_x,
        "origin_y": origin_y,
        "scale_factor": scale,
        "pixel_width": pw,
        "pixel_height": ph,
    }))
}

// ──────────────────────────────────────────────────────────────────────────────
// load_image
// ──────────────────────────────────────────────────────────────────────────────

pub async fn handle_load_image(params: Value, img_cache: Arc<RwLock<ImageCache>>) -> Result<Value> {
    let path = params.get("path").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("path required".into()))?
        .to_string();

    let png = tokio::task::spawn_blocking(move || {
        let data = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
        // Normalise to PNG
        let img = image::load_from_memory(&data).map_err(|e| format!("decode: {e}"))?;
        let mut out = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .map_err(|e| format!("png encode: {e}"))?;
        Ok::<_, String>(out)
    }).await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Image)?;

    let id = img_cache.write().await.store(png);
    Ok(json!({ "image_id": id }))
}

// ──────────────────────────────────────────────────────────────────────────────
// find_image
// ──────────────────────────────────────────────────────────────────────────────

pub async fn handle_find_image(
    params:    Value,
    ss_cache:  Arc<RwLock<ScreenshotCache>>,
    img_cache: Arc<RwLock<ImageCache>>,
) -> Result<Value> {
    // Resolve screenshot
    let screenshot_png = resolve_screenshot_png(&params, &ss_cache).await?;

    // Resolve template
    let template_png = if let Some(id) = params.get("template_id").and_then(|v| v.as_str()) {
        img_cache.write().await.get(id)
            .ok_or_else(|| DevToolsError::Input(format!("template_id '{}' not in cache", id)))?
            .png_data
    } else if let Some(b64) = params.get("template_base64").and_then(|v| v.as_str()) {
        B64.decode(b64).map_err(|e| DevToolsError::Input(format!("template_base64: {e}")))?
    } else {
        return Err(DevToolsError::Input("template_id or template_base64 required".into()));
    };

    let mask_png: Option<Vec<u8>> = if let Some(b64) = params.get("mask_base64").and_then(|v| v.as_str()) {
        Some(B64.decode(b64).map_err(|e| DevToolsError::Input(format!("mask_base64: {e}")))?)
    } else { None };

    // Parse search params
    let scales = params.get("scales")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let rotations: Vec<f64> = params.get("rotations")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_else(|| vec![0.0]);
    let threshold = params.get("threshold").and_then(|v| v.as_f64()).unwrap_or(0.75);
    let max_results = params.get("max_results").and_then(|v| v.as_u64()).unwrap_or(5) as usize;
    let fast = params.get("fast").and_then(|v| v.as_bool()).unwrap_or(false);
    let stride = if fast { 2u32 } else { 1u32 };

    let region: Option<SearchRegion> = params.get("search_region")
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    // Coordinate meta from cache
    let meta: Option<ScreenshotMeta> = if let Some(id) = params.get("screenshot_id").and_then(|v| v.as_str()) {
        ss_cache.read().await.peek(id).map(|e| ScreenshotMeta {
            origin_x: e.metadata.origin_x,
            origin_y: e.metadata.origin_y,
            scale:    e.metadata.scale,
        })
    } else { None };

    let results = tokio::task::spawn_blocking(move || {
        fi_find(&screenshot_png, &template_png, mask_png.as_deref(),
                &scales, &rotations, threshold, max_results, stride,
                region.as_ref(), meta.as_ref(), fast)
    }).await.map_err(|e| DevToolsError::Other(format!("task: {e}")))?
        .map_err(DevToolsError::Image)?;

    Ok(json!({ "matches": results }))
}

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

async fn resolve_screenshot_png(params: &Value, cache: &RwLock<ScreenshotCache>) -> Result<Vec<u8>> {
    if let Some(id) = params.get("screenshot_id").and_then(|v| v.as_str()) {
        let guard = cache.read().await;
        return guard.peek(id)
            .map(|e| e.png_data.clone())
            .ok_or_else(|| DevToolsError::Input(format!("screenshot_id '{}' not in cache", id)));
    }
    if let Some(b64) = params.get("screenshot_base64").and_then(|v| v.as_str()) {
        return B64.decode(b64)
            .map_err(|e| DevToolsError::Input(format!("screenshot_base64: {e}")));
    }
    Err(DevToolsError::Input("screenshot_id or screenshot_base64 required".into()))
}
