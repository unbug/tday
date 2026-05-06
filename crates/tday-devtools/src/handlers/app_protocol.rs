//! App protocol handlers — connect to and control an app via AppDebugKit WebSocket.

use crate::app_protocol::AppProtocolClient;
use rmcp::model::{CallToolResult, Content};
use rmcp::service::{Peer, RoleServer};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::RwLock;

pub type SharedAppClient = Arc<RwLock<Option<AppProtocolClient>>>;

const RELIST_HINT: &str = "Re-list tools to see app_* tools if your client doesn't auto-refresh.";

/// Helper to get a cloned client, releasing the lock before async operations
async fn get_client(shared: &SharedAppClient) -> Option<AppProtocolClient> {
    shared.read().await.clone()
}

#[derive(Debug, Deserialize)]
pub struct AppConnectParams {
    pub url: String,
    #[serde(default)]
    pub expected_bundle_id: Option<String>,
    #[serde(default)]
    pub expected_app_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppGetTreeParams {
    #[serde(default)]
    pub depth: Option<i32>,
    #[serde(default)]
    pub root_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppQueryParams {
    pub selector: String,
    #[serde(default)]
    pub all: bool,
}

#[derive(Debug, Deserialize)]
pub struct AppGetElementParams {
    pub element_id: String,
}

#[derive(Debug, Deserialize)]
pub struct AppClickParams {
    pub element_id: String,
    #[serde(default)]
    pub click_count: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct AppTypeParams {
    pub text: String,
    #[serde(default)]
    pub element_id: Option<String>,
    #[serde(default)]
    pub clear_first: bool,
}

#[derive(Debug, Deserialize)]
pub struct AppPressKeyParams {
    pub key: String,
    #[serde(default)]
    pub modifiers: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppFocusParams {
    pub element_id: String,
}

#[derive(Debug, Deserialize)]
pub struct AppScreenshotParams {
    #[serde(default)]
    pub element_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AppFocusWindowParams {
    pub window_id: String,
}

pub async fn app_connect(
    params: AppConnectParams,
    client: SharedAppClient,
    peer: Peer<RoleServer>,
) -> CallToolResult {
    let new_client = match AppProtocolClient::connect(&params.url).await {
        Ok(c) => c,
        Err(e) => return CallToolResult::error(vec![Content::text(format!("Failed to connect: {e}"))]),
    };

    // Get runtime info
    let info = match new_client.get_runtime_info().await {
        Ok(info) => info,
        Err(e) => {
            if params.expected_bundle_id.is_some() || params.expected_app_name.is_some() {
                new_client.close();
                return CallToolResult::error(vec![Content::text(format!(
                    "Failed to get app info for validation: {e}."
                ))]);
            }
            *client.write().await = Some(new_client);
            let _ = peer.notify_tool_list_changed().await;
            return CallToolResult::success(vec![Content::text(format!(
                "Connected to {}. App debug tools (app_*) are now available. {}",
                params.url, RELIST_HINT
            ))]);
        }
    };

    // Validate bundle ID
    if let Some(expected_bid) = &params.expected_bundle_id {
        let actual_bid = info.get("bundleId").and_then(|v| v.as_str()).unwrap_or("");
        if expected_bid != actual_bid {
            new_client.close();
            return CallToolResult::error(vec![Content::text(format!(
                "Bundle ID mismatch: expected '{}', got '{}'",
                expected_bid, actual_bid
            ))]);
        }
    }

    // Validate app name
    if let Some(expected_name) = &params.expected_app_name {
        let actual_name = info.get("appName").and_then(|v| v.as_str()).unwrap_or("").trim();
        if !expected_name.trim().eq_ignore_ascii_case(actual_name) {
            new_client.close();
            return CallToolResult::error(vec![Content::text(format!(
                "App name mismatch: expected '{}', got '{}'",
                expected_name, actual_name
            ))]);
        }
    }

    *client.write().await = Some(new_client);
    let _ = peer.notify_tool_list_changed().await;

    let msg = format!(
        "Connected. App debug tools (app_*) are now available. {}\n\n{}",
        RELIST_HINT,
        serde_json::to_string_pretty(&info).unwrap_or_default()
    );
    CallToolResult::success(vec![Content::text(msg)])
}

pub async fn app_disconnect(client: SharedAppClient, peer: Peer<RoleServer>) -> CallToolResult {
    if let Some(c) = client.write().await.take() {
        c.close();
        let _ = peer.notify_tool_list_changed().await;
        CallToolResult::success(vec![Content::text("Disconnected from app.")])
    } else {
        CallToolResult::error(vec![Content::text("Not connected to any app.")])
    }
}

pub async fn app_get_info(client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.get_runtime_info().await {
        Ok(info) => CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&info).unwrap_or_default(),
        )]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_get_tree(params: AppGetTreeParams, client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.get_tree(params.depth, params.root_id.as_deref()).await {
        Ok(tree) => CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&tree).unwrap_or_default(),
        )]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_query(params: AppQueryParams, client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    let result = if params.all {
        c.query_selector_all(&params.selector).await
    } else {
        c.query_selector(&params.selector).await
    };
    match result {
        Ok(elements) => CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&elements).unwrap_or_default(),
        )]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_get_element(params: AppGetElementParams, client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.get_element(&params.element_id).await {
        Ok(el) => CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&el).unwrap_or_default(),
        )]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_click(params: AppClickParams, client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.click(&params.element_id, params.click_count).await {
        Ok(_) => CallToolResult::success(vec![Content::text(format!(
            "Clicked element: {}",
            params.element_id
        ))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_type(params: AppTypeParams, client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.type_text(&params.text, params.element_id.as_deref(), params.clear_first).await {
        Ok(_) => CallToolResult::success(vec![Content::text(format!("Typed: {}", params.text))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_press_key(params: AppPressKeyParams, client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.press_key(&params.key, params.modifiers).await {
        Ok(_) => CallToolResult::success(vec![Content::text(format!("Pressed: {}", params.key))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_focus(params: AppFocusParams, client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.focus(&params.element_id).await {
        Ok(_) => CallToolResult::success(vec![Content::text(format!(
            "Focused element: {}",
            params.element_id
        ))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_screenshot(params: AppScreenshotParams, client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.get_screenshot(params.element_id.as_deref()).await {
        Ok(result) => {
            if let Some(data) = result.get("data").and_then(|v| v.as_str()) {
                let width = result.get("width").and_then(|v| v.as_i64()).unwrap_or(0);
                let height = result.get("height").and_then(|v| v.as_i64()).unwrap_or(0);
                CallToolResult::success(vec![
                    Content::text(format!("Screenshot: {}x{}", width, height)),
                    Content::image(data, "image/png"),
                ])
            } else {
                CallToolResult::error(vec![Content::text("Invalid screenshot response")])
            }
        }
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_list_windows(client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.list_windows().await {
        Ok(windows) => CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&windows).unwrap_or_default(),
        )]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

pub async fn app_focus_window(params: AppFocusWindowParams, client: SharedAppClient) -> CallToolResult {
    let Some(c) = get_client(&client).await else {
        return CallToolResult::error(vec![Content::text("Not connected. Use app_connect first.")]);
    };
    match c.focus_window(&params.window_id).await {
        Ok(_) => CallToolResult::success(vec![Content::text(format!(
            "Focused window: {}",
            params.window_id
        ))]),
        Err(e) => CallToolResult::error(vec![Content::text(format!("Failed: {e}"))]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_connect_params_deserialize() {
        let json = serde_json::json!({
            "url": "ws://localhost:9229",
            "expected_bundle_id": "com.example.App"
        });
        let params: AppConnectParams = serde_json::from_value(json).unwrap();
        assert_eq!(params.url, "ws://localhost:9229");
        assert_eq!(params.expected_bundle_id, Some("com.example.App".to_string()));
        assert_eq!(params.expected_app_name, None);
    }
}
