//! Android device handlers.

use base64::Engine as _;
use crate::android::AndroidDevice;
use rmcp::model::{CallToolResult, Content};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::RwLock;

pub type SharedAndroid = Arc<RwLock<Option<AndroidDevice>>>;

#[derive(Debug, Deserialize)]
pub struct AndroidConnectParams {
    pub serial: String,
}

#[derive(Debug, Deserialize)]
pub struct AndroidClickParams {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Deserialize)]
pub struct AndroidSwipeParams {
    pub start_x: f64,
    pub start_y: f64,
    pub end_x: f64,
    pub end_y: f64,
    #[serde(default)]
    pub duration_ms: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct AndroidTypeParams {
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct AndroidPressKeyParams {
    pub key: String,
}

#[derive(Debug, Deserialize)]
pub struct AndroidLaunchAppParams {
    pub package: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub activity: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AndroidFindTextParams {
    pub text: String,
}

pub async fn android_list_devices() -> CallToolResult {
    let result = tokio::task::spawn_blocking(crate::android::device::list_devices).await;
    match result {
        Ok(Ok(devices)) => CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&devices).unwrap_or_default(),
        )]),
        Ok(Err(e)) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Task error: {e}"))]),
    }
}

pub async fn android_connect(params: AndroidConnectParams, device: SharedAndroid) -> CallToolResult {
    let serial = params.serial.clone();
    let result = tokio::task::spawn_blocking(move || AndroidDevice::connect(&serial)).await;
    match result {
        Ok(Ok(d)) => {
            *device.write().await = Some(d);
            CallToolResult::success(vec![Content::text(format!(
                "Connected to Android device: {}",
                params.serial
            ))])
        }
        Ok(Err(e)) => CallToolResult::error(vec![Content::text(format!("Failed to connect: {e}"))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Task error: {e}"))]),
    }
}

pub async fn android_disconnect(device: SharedAndroid) -> CallToolResult {
    if device.write().await.take().is_some() {
        CallToolResult::success(vec![Content::text("Disconnected from Android device.")])
    } else {
        CallToolResult::error(vec![Content::text("Not connected to any Android device.")])
    }
}

pub async fn android_screenshot(device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    match crate::android::screenshot::capture(dev) {
        Ok(info) => {
            let text = format!("Screenshot: {}x{} pixels", info.width, info.height);
            let b64 = base64::engine::general_purpose::STANDARD.encode(&info.png_data);
            CallToolResult::success(vec![
                Content::text(text),
                Content::image(&b64, "image/png"),
            ])
        }
        Err(e) => CallToolResult::error(vec![Content::text(format!("Screenshot failed: {e}"))]),
    }
}

pub async fn android_click(params: AndroidClickParams, device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    match crate::android::input::click(dev, params.x, params.y) {
        Ok(_) => CallToolResult::success(vec![Content::text(format!(
            "Tapped at ({}, {})",
            params.x, params.y
        ))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Click failed: {e}"))]),
    }
}

pub async fn android_swipe(params: AndroidSwipeParams, device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    match crate::android::input::swipe(
        dev,
        params.start_x,
        params.start_y,
        params.end_x,
        params.end_y,
        params.duration_ms,
    ) {
        Ok(_) => CallToolResult::success(vec![Content::text(format!(
            "Swiped from ({}, {}) to ({}, {})",
            params.start_x, params.start_y, params.end_x, params.end_y
        ))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Swipe failed: {e}"))]),
    }
}

pub async fn android_type_text(params: AndroidTypeParams, device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    match crate::android::input::type_text(dev, &params.text) {
        Ok(_) => CallToolResult::success(vec![Content::text(format!(
            "Typed: {}",
            params.text
        ))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Type failed: {e}"))]),
    }
}

pub async fn android_press_key(params: AndroidPressKeyParams, device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    let keycode = crate::android::navigation::key_name_to_keycode(&params.key);
    match crate::android::input::press_key(dev, &keycode) {
        Ok(_) => CallToolResult::success(vec![Content::text(format!("Pressed key: {}", params.key))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Key press failed: {e}"))]),
    }
}

pub async fn android_find_text(params: AndroidFindTextParams, device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    match crate::android::ui_automator::find_text(dev, &params.text) {
        Ok(results) => {
            let json = serde_json::json!({
                "matches": results.matches,
                "available_elements": results.available_elements,
            });
            CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&json).unwrap_or_default(),
            )])
        }
        Err(e) => CallToolResult::error(vec![Content::text(format!("Find text failed: {e}"))]),
    }
}

pub async fn android_list_apps(device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    match crate::android::navigation::list_apps(dev, true) {
        Ok(apps) => CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&apps).unwrap_or_default(),
        )]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("List apps failed: {e}"))]),
    }
}

pub async fn android_launch_app(params: AndroidLaunchAppParams, device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    match crate::android::navigation::launch_app(dev, &params.package) {
        Ok(_) => CallToolResult::success(vec![Content::text(format!(
            "Launched: {}",
            params.package
        ))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Launch failed: {e}"))]),
    }
}

pub async fn android_get_display_info(device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    match crate::android::navigation::get_display_info(dev) {
        Ok(info) => CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&info).unwrap_or_default(),
        )]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn android_get_current_activity(device: SharedAndroid) -> CallToolResult {
    let mut guard = device.write().await;
    let Some(dev) = guard.as_mut() else {
        return CallToolResult::error(vec![Content::text("Not connected. Use android_connect first.")]);
    };
    match crate::android::navigation::get_current_activity(dev) {
        Ok(activity) => CallToolResult::success(vec![Content::text(
            format!("{}/{}", activity.package, activity.activity)
        )]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}
