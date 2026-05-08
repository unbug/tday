// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

/// MCP ServerHandler — registers all tools and dispatches `call_tool`.

use crate::handlers;
use crate::handlers::android::SharedAndroid;
use crate::handlers::app_protocol::SharedAppClient;
use crate::handlers::tracking::{SharedHoverTracker, SharedScreenRecorder};
use crate::session::{AxSession, ImageCache, ScreenshotCache};
#[cfg(feature = "cdp")]
use crate::cdp::CdpClient;
use rmcp::{
    handler::server::ServerHandler,
    model::{
        CallToolRequestParam, CallToolResult, Content, Implementation, ListToolsResult,
        PaginatedRequestParam, ProtocolVersion, ServerCapabilities, ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
    Error as McpError,
    Peer,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct DevToolsServer {
    ss_cache:      Arc<RwLock<ScreenshotCache>>,
    img_cache:     Arc<RwLock<ImageCache>>,
    ax:            Arc<AxSession>,
    android:       SharedAndroid,
    app_client:    SharedAppClient,
    hover_tracker: SharedHoverTracker,
    screen_rec:    SharedScreenRecorder,
    #[cfg(feature = "cdp")]
    cdp_client:    Arc<RwLock<Option<CdpClient>>>,
}

impl DevToolsServer {
    pub fn new() -> Self {
        Self {
            ss_cache:      Arc::new(RwLock::new(ScreenshotCache::default())),
            img_cache:     Arc::new(RwLock::new(ImageCache::default())),
            ax:            Arc::new(AxSession::new()),
            android:       Arc::new(RwLock::new(None)),
            app_client:    Arc::new(RwLock::new(None)),
            hover_tracker: Arc::new(RwLock::new(None)),
            screen_rec:    Arc::new(RwLock::new(None)),
            #[cfg(feature = "cdp")]
            cdp_client:    Arc::new(RwLock::new(None)),
        }
    }
}

impl Default for DevToolsServer {
    fn default() -> Self { Self::new() }
}

// ──────────────────────────────────────────────────────────────────────────────
// ServerHandler implementation
// ──────────────────────────────────────────────────────────────────────────────

impl ServerHandler for DevToolsServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::V_2024_11_05,
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
            server_info: Implementation {
                name: "tday-nativecore".into(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            instructions: Some(
                "Native desktop automation MCP server for macOS, Windows, and Linux.\n\
                 take_screenshot -> find_text/find_image to locate elements.\n\
                 click/type_text for coordinate input.\n\
                 take_ax_snapshot + ax_click/ax_set_value for element-precise automation.\n\
                 get_page_content: fastest way to read all text from a focused window (Select-All + Copy).\n"
                .into(),
            ),
        }
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParam>,
        _ctx: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, McpError> {
        Ok(ListToolsResult { tools: tool_list(), next_cursor: None })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParam,
        ctx: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResult, McpError> {
        let params: Value = request.arguments
            .map(Value::Object)
            .unwrap_or(Value::Object(Default::default()));

        let result = dispatch(
            &request.name,
            params,
            self.ss_cache.clone(),
            self.img_cache.clone(),
            self.ax.clone(),
            self.android.clone(),
            self.app_client.clone(),
            self.hover_tracker.clone(),
            self.screen_rec.clone(),
            #[cfg(feature = "cdp")]
            self.cdp_client.clone(),
            ctx.peer.clone(),
        ).await;

        Ok(match result {
            Ok(v)  => ok_result(v),
            Err(e) => CallToolResult {
                content: vec![Content::text(format!(r#"{{"error":"{e}"}}"#))],
                is_error: Some(true),
            },
        })
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ──────────────────────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn dispatch(
    name:      &str,
    params:    Value,
    ss_cache:  Arc<RwLock<ScreenshotCache>>,
    img_cache: Arc<RwLock<ImageCache>>,
    ax:        Arc<AxSession>,
    android:   SharedAndroid,
    app_client: SharedAppClient,
    hover_tracker: SharedHoverTracker,
    screen_rec:    SharedScreenRecorder,
    #[cfg(feature = "cdp")]
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
    peer: Peer<RoleServer>,
) -> crate::error::Result<Value> {
    use crate::error::DevToolsError;

    // Helper: run a CallToolResult handler and convert to Result<Value>
    macro_rules! tool {
        ($e:expr) => {{
            let r: CallToolResult = $e;
            let text = r.content.iter()
                .filter_map(|c| c.as_text().map(|t| t.text.clone()))
                .collect::<Vec<_>>()
                .join("\n");
            if r.is_error == Some(true) {
                return Err(DevToolsError::Input(text));
            }
            return Ok(serde_json::Value::String(text));
        }};
    }

    match name {
        // ── Screenshot
        "take_screenshot"  => handlers::handle_take_screenshot(params, ss_cache).await,
        "load_image"       => handlers::handle_load_image(params, img_cache).await,
        "find_image"       => handlers::handle_find_image(params, ss_cache, img_cache).await,

        // ── Input
        "click"            => handlers::handle_click(params).await,
        "double_click"     => {
            let mut p = params.clone();
            p["click_count"] = json!(2);
            handlers::handle_click(p).await
        }
        "right_click"      => {
            let mut p = params.clone();
            p["button"] = json!("right");
            handlers::handle_click(p).await
        }
        "drag"             => handlers::handle_drag(params).await,
        "scroll"           => handlers::handle_scroll(params).await,
        "move_mouse"       => handlers::handle_move_mouse(params).await,
        "type_text"        => handlers::handle_type_text(params).await,
        "press_key"        => handlers::handle_press_key(params).await,
        "shortcut"         => handlers::handle_shortcut(params).await,
        "get_cursor_position" => handlers::handle_get_cursor_position(params).await,

        // ── Navigation
        "list_windows"     => handlers::handle_list_windows(params).await,
        "list_apps"        => handlers::handle_list_apps(params).await,
        "get_displays"     => handlers::handle_get_displays(params).await,
        "focus_window"     => handlers::handle_focus_window(params).await,
        "launch_app"       => handlers::handle_launch_app(params).await,
        "quit_app"         => handlers::handle_quit_app(params).await,
        "resize_window"    => handlers::handle_resize_window(params).await,
        "find_text"        => handlers::handle_find_text(params).await,
        "element_at_point" => handlers::handle_element_at_point(params).await,

        // ── Accessibility
        "take_ax_snapshot"    => handlers::handle_take_ax_snapshot(params, ax).await,
        "ax_click"            => handlers::handle_ax_click(params, ax).await,
        "ax_set_value"        => handlers::handle_ax_set_value(params, ax).await,
        "ax_select"           => handlers::handle_ax_select(params, ax).await,
        "ax_perform_action"   => handlers::handle_ax_perform_action(params, ax).await,

        // ── Probe
        "probe_app" => {
            let name_str: String = params["app_name"].as_str()
                .ok_or_else(|| DevToolsError::Input("app_name required".into()))?
                .to_string();
            tool!(handlers::probe_app(&name_str))
        }

        // ── System
        "sys_wait"        => handlers::handle_wait(params).await,
        "scrape"          => handlers::handle_scrape(params).await,
        "execute_command" => handlers::handle_execute_command(params).await,
        "clipboard"       => handlers::handle_clipboard(params).await,
        "get_page_content" => handlers::handle_get_page_content(params).await,
        "sys_process"     => handlers::handle_process(params).await,
        "filesystem"      => handlers::handle_filesystem(params).await,

        // ── Android
        "android_list_devices" => tool!(handlers::android_list_devices().await),
        "android_connect" => {
            let p: handlers::android::AndroidConnectParams = parse_params(&params)?;
            tool!(handlers::android_connect(p, android).await)
        }
        "android_disconnect" => tool!(handlers::android_disconnect(android).await),
        "android_screenshot" => tool!(handlers::android_screenshot(android).await),
        "android_click" => {
            let p: handlers::android::AndroidClickParams = parse_params(&params)?;
            tool!(handlers::android_click(p, android).await)
        }
        "android_swipe" => {
            let p: handlers::android::AndroidSwipeParams = parse_params(&params)?;
            tool!(handlers::android_swipe(p, android).await)
        }
        "android_type_text" => {
            let p: handlers::android::AndroidTypeParams = parse_params(&params)?;
            tool!(handlers::android_type_text(p, android).await)
        }
        "android_press_key" => {
            let p: handlers::android::AndroidPressKeyParams = parse_params(&params)?;
            tool!(handlers::android_press_key(p, android).await)
        }
        "android_find_text" => {
            let p: handlers::android::AndroidFindTextParams = parse_params(&params)?;
            tool!(handlers::android_find_text(p, android).await)
        }
        "android_list_apps" => tool!(handlers::android_list_apps(android).await),
        "android_launch_app" => {
            let p: handlers::android::AndroidLaunchAppParams = parse_params(&params)?;
            tool!(handlers::android_launch_app(p, android).await)
        }
        "android_get_display_info" => tool!(handlers::android_get_display_info(android).await),
        "android_get_current_activity" => tool!(handlers::android_get_current_activity(android).await),

        // ── App Protocol (Electron / native WebSocket)
        "app_connect" => {
            let p: handlers::app_protocol::AppConnectParams = parse_params(&params)?;
            tool!(handlers::app_connect(p, app_client, peer).await)
        }
        "app_disconnect" => tool!(handlers::app_disconnect(app_client, peer).await),
        "app_get_info"   => tool!(handlers::app_get_info(app_client).await),
        "app_get_tree"   => {
            let p: handlers::app_protocol::AppGetTreeParams = parse_params(&params)?;
            tool!(handlers::app_get_tree(p, app_client).await)
        }
        "app_query" => {
            let p: handlers::app_protocol::AppQueryParams = parse_params(&params)?;
            tool!(handlers::app_query(p, app_client).await)
        }
        "app_get_element" => {
            let p: handlers::app_protocol::AppGetElementParams = parse_params(&params)?;
            tool!(handlers::app_get_element(p, app_client).await)
        }
        "app_click" => {
            let p: handlers::app_protocol::AppClickParams = parse_params(&params)?;
            tool!(handlers::app_click(p, app_client).await)
        }
        "app_type" => {
            let p: handlers::app_protocol::AppTypeParams = parse_params(&params)?;
            tool!(handlers::app_type(p, app_client).await)
        }
        "app_press_key" => {
            let p: handlers::app_protocol::AppPressKeyParams = parse_params(&params)?;
            tool!(handlers::app_press_key(p, app_client).await)
        }
        "app_focus" => {
            let p: handlers::app_protocol::AppFocusParams = parse_params(&params)?;
            tool!(handlers::app_focus(p, app_client).await)
        }
        "app_screenshot" => {
            let p: handlers::app_protocol::AppScreenshotParams = parse_params(&params)?;
            tool!(handlers::app_screenshot(p, app_client).await)
        }
        "app_list_windows" => tool!(handlers::app_list_windows(app_client).await),
        "app_focus_window" => {
            let p: handlers::app_protocol::AppFocusWindowParams = parse_params(&params)?;
            tool!(handlers::app_focus_window(p, app_client).await)
        }

        // ── Hover tracking
        "start_hover_tracking" => {
            let p: handlers::tracking::StartHoverTrackingParams = parse_params(&params)?;
            tool!(handlers::start_hover_tracking(p, hover_tracker).await)
        }
        "get_hover_events" => tool!(handlers::get_hover_events(hover_tracker).await),
        "stop_hover_tracking" => tool!(handlers::stop_hover_tracking(hover_tracker).await),

        // ── Screen recording
        "start_recording" => {
            let p: handlers::tracking::StartRecordingParams = parse_params(&params)?;
            tool!(handlers::start_recording_handler(p, screen_rec).await)
        }
        "stop_recording" => tool!(handlers::stop_recording_handler(screen_rec).await),

        // ── CDP
        #[cfg(feature = "cdp")]
        "cdp_connect" => {
            let port: u16 = params["port"].as_u64()
                .ok_or_else(|| DevToolsError::Input("port required".into()))? as u16;
            let client = CdpClient::connect(port).await.map_err(DevToolsError::Input)?;
            *cdp_client.write().await = Some(client);
            let _ = peer.notify_tool_list_changed().await;
            return Ok(json!({ "ok": true, "port": port }));
        }
        #[cfg(feature = "cdp")]
        "cdp_disconnect" => {
            let taken = cdp_client.write().await.take();
            if let Some(c) = taken {
                c.disconnect();
            }
            let _ = peer.notify_tool_list_changed().await;
            return Ok(json!({ "ok": true }));
        }
        #[cfg(feature = "cdp")]
        "cdp_take_dom_snapshot" => {
            let max = params["max_nodes"].as_u64().map(|n| n as u32);
            tool!(crate::cdp::tools::cdp_take_dom_snapshot(max, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_summarize_page" => {
            tool!(crate::cdp::tools::cdp_summarize_page(cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_find_elements" => {
            let query: String = params["query"].as_str()
                .ok_or_else(|| DevToolsError::Input("query required".into()))?.into();
            let role = params["role"].as_str().map(|s| s.to_string());
            let max = params["max_results"].as_u64().map(|n| n as u32);
            tool!(crate::cdp::tools::cdp_find_elements(query, role, max, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_get_element_context" => {
            let uid: String = params["uid"].as_str()
                .ok_or_else(|| DevToolsError::Input("uid required".into()))?.into();
            let ancestor_depth = params["ancestor_depth"].as_u64().map(|n| n as u32);
            let sibling_limit = params["sibling_limit"].as_u64().map(|n| n as u32);
            let child_limit = params["child_limit"].as_u64().map(|n| n as u32);
            let max_chars = params["max_chars"].as_u64().map(|n| n as u32);
            tool!(crate::cdp::tools::cdp_get_element_context(uid, ancestor_depth, sibling_limit, child_limit, max_chars, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_evaluate_script" => {
            let function: String = params["script"].as_str()
                .ok_or_else(|| DevToolsError::Input("script required".into()))?.into();
            let args = params["args"].as_array().cloned();
            tool!(crate::cdp::tools::cdp_evaluate_script(function, args, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_click" => {
            let uid: String = params["uid"].as_str()
                .ok_or_else(|| DevToolsError::Input("uid required".into()))?.into();
            let dbl = params["double_click"].as_bool().unwrap_or(false);
            let snap = params["include_snapshot"].as_bool().unwrap_or(false);
            tool!(crate::cdp::tools::cdp_click(uid, dbl, snap, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_hover" => {
            let uid: String = params["uid"].as_str()
                .ok_or_else(|| DevToolsError::Input("uid required".into()))?.into();
            let snap = params["include_snapshot"].as_bool().unwrap_or(false);
            tool!(crate::cdp::tools::cdp_hover(uid, snap, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_fill" => {
            let uid: String = params["uid"].as_str()
                .ok_or_else(|| DevToolsError::Input("uid required".into()))?.into();
            let value: String = params["value"].as_str()
                .ok_or_else(|| DevToolsError::Input("value required".into()))?.into();
            let snap = params["include_snapshot"].as_bool().unwrap_or(false);
            tool!(crate::cdp::tools::cdp_fill(uid, value, snap, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_press_key" => {
            let key: String = params["key"].as_str()
                .ok_or_else(|| DevToolsError::Input("key required".into()))?.into();
            let snap = params["include_snapshot"].as_bool().unwrap_or(false);
            tool!(crate::cdp::tools::cdp_press_key(key, snap, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_type_text" => {
            let text: String = params["text"].as_str()
                .ok_or_else(|| DevToolsError::Input("text required".into()))?.into();
            let submit_key = params["submit_key"].as_str().map(|s| s.to_string());
            tool!(crate::cdp::tools::cdp_type_text(text, submit_key, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_list_pages" => {
            tool!(crate::cdp::tools::cdp_list_pages(cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_select_page" => {
            let idx = params["page_index"].as_u64()
                .ok_or_else(|| DevToolsError::Input("page_index required".into()))? as usize;
            tool!(crate::cdp::tools::cdp_select_page(idx, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_navigate" => {
            let url = params["url"].as_str().map(|s| s.to_string());
            let nav_type = params["nav_type"].as_str().map(|s| s.to_string());
            let timeout_ms = params["timeout_ms"].as_u64();
            tool!(crate::cdp::tools::cdp_navigate(url, nav_type, timeout_ms, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_new_page" => {
            let url: String = params["url"].as_str().unwrap_or("about:blank").into();
            tool!(crate::cdp::tools::cdp_new_page(url, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_close_page" => {
            let idx: usize = params["page_index"].as_u64()
                .ok_or_else(|| DevToolsError::Input("page_index required".into()))? as usize;
            tool!(crate::cdp::tools::cdp_close_page(idx, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_handle_dialog" => {
            let action = params["action"].as_str().unwrap_or("accept").to_string();
            let prompt_text = params["prompt_text"].as_str().map(|s| s.to_string());
            tool!(crate::cdp::tools::cdp_handle_dialog(action, prompt_text, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_wait_for" => {
            let texts: Vec<String> = if let Some(arr) = params["texts"].as_array() {
                arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
            } else if let Some(s) = params["selector"].as_str() {
                vec![s.to_string()]
            } else {
                return Err(DevToolsError::Input("texts or selector required".into()));
            };
            let timeout_ms = params["timeout_ms"].as_u64();
            let include_snapshot = params["include_snapshot"].as_bool().unwrap_or(false);
            tool!(crate::cdp::tools::cdp_wait_for(texts, timeout_ms, include_snapshot, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_wait_for_page_change" => {
            let scope_uid = params["scope_uid"].as_str().map(|s| s.to_string());
            let condition = params["condition"].as_str().map(|s| s.to_string());
            let goal = params["goal"].as_str().map(|s| s.to_string());
            let timeout_ms = params["timeout_ms"].as_u64();
            let poll_interval_ms = params["poll_interval_ms"].as_u64();
            let stable_ms = params["stable_ms"].as_u64();
            let include_snapshot = params["include_snapshot"].as_bool().unwrap_or(false);
            tool!(crate::cdp::tools::cdp_wait_for_page_change(scope_uid, condition, goal, timeout_ms, poll_interval_ms, stable_ms, include_snapshot, cdp_client).await)
        }
        #[cfg(feature = "cdp")]
        "cdp_element_at_point" => {
            let x = params["x"].as_f64()
                .ok_or_else(|| DevToolsError::Input("x required".into()))?;
            let y = params["y"].as_f64()
                .ok_or_else(|| DevToolsError::Input("y required".into()))?;
            tool!(crate::cdp::tools::cdp_element_at_point(x, y, cdp_client).await)
        }

        other => Err(DevToolsError::Input(format!("unknown tool: {other}"))),
    }
}

fn parse_params<T: serde::de::DeserializeOwned>(
    v: &Value,
) -> crate::error::Result<T> {
    serde_json::from_value(v.clone())
        .map_err(|e| crate::error::DevToolsError::Input(format!("Invalid params: {e}")))
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ──────────────────────────────────────────────────────────────────────────────

fn ok_result(v: Value) -> CallToolResult {
    CallToolResult { content: vec![Content::text(serde_json::to_string_pretty(&v).unwrap_or_default())], is_error: Some(false) }
}

fn t(name: &'static str, desc: &'static str, schema: Value) -> Tool {
    Tool::new(name, desc, Arc::new(schema.as_object().cloned().unwrap_or_default()))
}

fn tool_list() -> Vec<Tool> {
    let mut tools = vec![
        // ── Screenshot
        t("take_screenshot", "Capture the screen or a specific window as JPEG",
            json!({
                "type": "object",
                "properties": {
                    "window_id": { "type": "integer", "description": "Optional CGWindowID" }
                }
            })),
        t("load_image", "Load an image file into the cache for use as a find_image template",
            json!({
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the image file" }
                }
            })),
        t("find_image", "Locate a template image within a screenshot using NCC",
            json!({
                "type": "object",
                "properties": {
                    "screenshot_id":     { "type": "string" },
                    "screenshot_base64": { "type": "string" },
                    "template_id":       { "type": "string" },
                    "template_base64":   { "type": "string" },
                    "mask_base64":       { "type": "string" },
                    "threshold":         { "type": "number",  "default": 0.75 },
                    "max_results":       { "type": "integer", "default": 5 },
                    "fast":              { "type": "boolean", "default": false },
                    "rotations":         { "type": "array",   "items": { "type": "number" } },
                    "scales": {
                        "type": "object",
                        "properties": {
                            "min":  { "type": "number" },
                            "max":  { "type": "number" },
                            "step": { "type": "number" }
                        }
                    },
                    "search_region": {
                        "type": "object",
                        "properties": {
                            "x": { "type": "integer" }, "y": { "type": "integer" },
                            "w": { "type": "integer" }, "h": { "type": "integer" }
                        }
                    }
                }
            })),

        // ── Input
        t("click", "Click at (x, y)",
            json!({
                "type": "object",
                "required": ["x", "y"],
                "properties": {
                    "x": { "type": "number" }, "y": { "type": "number" },
                    "button":      { "type": "string", "enum": ["left","right","middle"], "default": "left" },
                    "click_count": { "type": "integer", "default": 1 }
                }
            })),
        t("double_click", "Double-click at (x, y)",
            json!({
                "type": "object",
                "required": ["x", "y"],
                "properties": { "x": { "type": "number" }, "y": { "type": "number" } }
            })),
        t("right_click", "Right-click at (x, y)",
            json!({
                "type": "object",
                "required": ["x", "y"],
                "properties": { "x": { "type": "number" }, "y": { "type": "number" } }
            })),
        t("drag", "Drag from (start_x, start_y) to (end_x, end_y)",
            json!({
                "type": "object",
                "required": ["start_x","start_y","end_x","end_y"],
                "properties": {
                    "start_x": { "type": "number" }, "start_y": { "type": "number" },
                    "end_x":   { "type": "number" }, "end_y":   { "type": "number" },
                    "button":  { "type": "string",  "enum": ["left","right","middle"], "default": "left" }
                }
            })),
        t("scroll", "Scroll at (x, y). Use direction+wheel_times (preferred) or delta_x/delta_y.",
            json!({
                "type": "object",
                "required": ["x", "y"],
                "properties": {
                    "x": { "type": "number" }, "y": { "type": "number" },
                    "direction":   { "type": "string", "enum": ["up","down","left","right"], "description": "Preferred: scroll direction" },
                    "wheel_times": { "type": "integer", "default": 1, "description": "Number of wheel ticks (used with direction)" },
                    "delta_x": { "type": "number", "default": 0, "description": "Legacy: horizontal delta" },
                    "delta_y": { "type": "number", "default": 0, "description": "Legacy: vertical delta" }
                }
            })),
        t("move_mouse", "Move the cursor to (x, y), or drag from current position if drag=true",
            json!({
                "type": "object",
                "required": ["x", "y"],
                "properties": {
                    "x":    { "type": "number" },
                    "y":    { "type": "number" },
                    "drag": { "type": "boolean", "default": false, "description": "If true, drag from current cursor position to (x,y)" }
                }
            })),
        t("type_text", "Type a string. Optionally click at (x,y) first, clear field, set caret position, and press Enter after.",
            json!({
                "type": "object",
                "required": ["text"],
                "properties": {
                    "text":           { "type": "string" },
                    "x":              { "type": "number", "description": "Click here to focus before typing" },
                    "y":              { "type": "number", "description": "Click here to focus before typing" },
                    "clear":          { "type": "boolean", "default": false, "description": "Select-all + delete existing text first" },
                    "caret_position": { "type": "string",  "enum": ["start","end","idle"], "default": "idle" },
                    "press_enter":    { "type": "boolean", "default": false, "description": "Press Return after typing" }
                }
            })),
        t("press_key", "Press a keyboard key with optional modifiers",
            json!({
                "type": "object",
                "required": ["key"],
                "properties": {
                    "key": { "type": "string" },
                    "modifiers": { "type": "array", "items": { "type": "string" } }
                }
            })),
        t("shortcut", "Execute a keyboard shortcut (e.g. 'command+c', 'ctrl+shift+s', 'return')",
            json!({
                "type": "object",
                "required": ["shortcut"],
                "properties": {
                    "shortcut": { "type": "string", "description": "Keys joined by '+', last token is the key, preceding are modifiers" }
                }
            })),
        t("get_cursor_position", "Return the current cursor (x, y)", json!({ "type": "object", "properties": {} })),

        // ── Navigation
        t("list_windows", "List all on-screen windows", json!({ "type": "object", "properties": {} })),
        t("list_apps",    "List running applications",   json!({ "type": "object", "properties": {} })),
        t("get_displays", "List all displays",           json!({ "type": "object", "properties": {} })),
        t("focus_window", "Bring a window to the front",
            json!({
                "type": "object",
                "required": ["window_id"],
                "properties": { "window_id": { "type": "integer" } }
            })),
        t("launch_app", "Launch an application by name",
            json!({
                "type": "object",
                "required": ["app_name"],
                "properties": {
                    "app_name":   { "type": "string" },
                    "args":       { "type": "array", "items": { "type": "string" } },
                    "background": { "type": "boolean", "default": false }
                }
            })),
        t("quit_app", "Quit an application by name",
            json!({
                "type": "object",
                "required": ["app_name"],
                "properties": {
                    "app_name": { "type": "string" },
                    "force":    { "type": "boolean", "default": false }
                }
            })),
        t("resize_window", "Move and/or resize the main window of a running application",
            json!({
                "type": "object",
                "required": ["app_name"],
                "properties": {
                    "app_name": { "type": "string", "description": "Name of the running application" },
                    "x":        { "type": "number", "description": "New left position" },
                    "y":        { "type": "number", "description": "New top position" },
                    "width":    { "type": "number", "description": "New window width" },
                    "height":   { "type": "number", "description": "New window height" }
                }
            })),
        t("find_text", "Search for text on screen (AX tree or OCR fallback)",
            json!({
                "type": "object",
                "required": ["text"],
                "properties": {
                    "text":               { "type": "string" },
                    "display_id":         { "type": "integer" },
                    "language_correction":{ "type": "boolean", "default": true },
                    "use_ax":             { "type": "boolean", "default": true }
                }
            })),
        t("element_at_point", "Return the AX element at screen coordinates",
            json!({
                "type": "object",
                "required": ["x", "y"],
                "properties": {
                    "x":        { "type": "number" },
                    "y":        { "type": "number" },
                    "app_name": { "type": "string" }
                }
            })),

        // ── Accessibility
        t("take_ax_snapshot", "Take a snapshot of the AX tree for an application",
            json!({
                "type": "object",
                "properties": {
                    "app_name": { "type": "string" },
                    "pid":      { "type": "integer" }
                }
            })),
        t("ax_click", "Click an element from a previous AX snapshot",
            json!({
                "type": "object",
                "required": ["uid"],
                "properties": { "uid": { "type": "string" } }
            })),
        t("ax_set_value", "Set the value of an AX element",
            json!({
                "type": "object",
                "required": ["uid", "value"],
                "properties": {
                    "uid":   { "type": "string" },
                    "value": { "type": "string" }
                }
            })),
        t("ax_select", "Select / open an AX element",
            json!({
                "type": "object",
                "required": ["uid"],
                "properties": { "uid": { "type": "string" } }
            })),
        t("ax_perform_action", "Perform an arbitrary AX action on an element",
            json!({
                "type": "object",
                "required": ["uid", "action"],
                "properties": {
                    "uid":    { "type": "string" },
                    "action": { "type": "string" }
                }
            })),

        // ── Probe
        t("probe_app", "Probe an application to determine its kind (Native, Electron, Chrome)",
            json!({
                "type": "object",
                "required": ["app_name"],
                "properties": { "app_name": { "type": "string" } }
            })),

        // ── System
        t("sys_wait", "Pause execution for N seconds (max 300). Use between rapid actions or while waiting for UI to settle.",
            json!({
                "type": "object",
                "required": ["duration"],
                "properties": {
                    "duration": { "type": "number", "description": "Seconds to wait (supports fractions, max 300)" }
                }
            })),
        t("scrape", "Fetch a URL via HTTP GET and return the response body as text",
            json!({
                "type": "object",
                "required": ["url"],
                "properties": {
                    "url": { "type": "string", "description": "https:// or http:// URL to fetch" }
                }
            })),
        t("execute_command", "Execute a shell or AppleScript command and return stdout/stderr/exit_code",
            json!({
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": { "type": "string" },
                    "mode":    { "type": "string", "enum": ["shell","osascript"], "default": "shell" },
                    "timeout": { "type": "integer", "default": 10, "description": "Seconds before killing the process (max 60)" }
                }
            })),
        t("clipboard", "Get or set the system clipboard text (macOS, Windows, Linux)",
            json!({
                "type": "object",
                "required": ["mode"],
                "properties": {
                    "mode": { "type": "string", "enum": ["get","set"] },
                    "text": { "type": "string", "description": "Required for mode=set" }
                }
            })),
        t("get_page_content",
            "Read full text content of the currently focused window by simulating Select-All → Copy and reading the clipboard. \
             Fastest way to obtain large bodies of text — no screenshot, no OCR, no AX tree traversal. \
             Works on macOS (Cmd+A/C), Windows and Linux (Ctrl+A/C). \
             Optionally restores the original clipboard after reading.",
            json!({
                "type": "object",
                "properties": {
                    "restore_clipboard": {
                        "type": "boolean",
                        "default": true,
                        "description": "Restore the original clipboard content after reading (default true)"
                    },
                    "wait_ms": {
                        "type": "integer",
                        "default": 200,
                        "description": "Milliseconds to wait after Copy before reading the clipboard (increase for slow apps, max 10000)"
                    }
                }
            })),
        t("sys_process", "List or kill OS processes",
            json!({
                "type": "object",
                "required": ["mode"],
                "properties": {
                    "mode":    { "type": "string", "enum": ["list","kill"] },
                    "name":    { "type": "string", "description": "Filter by name (list) or process name to kill" },
                    "pid":     { "type": "integer", "description": "PID to kill (kill mode)" },
                    "sort_by": { "type": "string", "enum": ["memory","cpu","name"], "default": "memory" },
                    "limit":   { "type": "integer", "default": 20 },
                    "force":   { "type": "boolean", "default": false, "description": "Use SIGKILL instead of SIGTERM" }
                }
            })),
        t("filesystem", "File system operations: read, write, list, delete, copy, move, info, search",
            json!({
                "type": "object",
                "required": ["mode", "path"],
                "properties": {
                    "mode":        { "type": "string", "enum": ["read","write","list","delete","copy","move","info","search"] },
                    "path":        { "type": "string", "description": "Absolute or ~-relative file/directory path" },
                    "content":     { "type": "string", "description": "write mode: content to write" },
                    "destination": { "type": "string", "description": "copy/move mode: destination path" },
                    "pattern":     { "type": "string", "description": "search mode: glob pattern (e.g. '*.rs')" },
                    "recursive":   { "type": "boolean", "default": false },
                    "append":      { "type": "boolean", "default": false, "description": "write mode: append instead of overwrite" },
                    "offset":      { "type": "integer", "description": "read mode: skip first N lines" },
                    "limit":       { "type": "integer", "description": "read mode: max lines to return" },
                    "show_hidden": { "type": "boolean", "default": false }
                }
            })),

        // ── Android
        t("android_list_devices", "List connected Android devices via ADB", json!({ "type": "object", "properties": {} })),
        t("android_connect", "Connect to an Android device",
            json!({
                "type": "object",
                "properties": {
                    "serial":    { "type": "string" },
                    "host":      { "type": "string" },
                    "port":      { "type": "integer" }
                }
            })),
        t("android_disconnect", "Disconnect the active Android device", json!({ "type": "object", "properties": {} })),
        t("android_screenshot", "Take a screenshot of the Android device screen", json!({ "type": "object", "properties": {} })),
        t("android_click", "Tap on the Android screen at (x, y)",
            json!({
                "type": "object",
                "required": ["x", "y"],
                "properties": {
                    "x": { "type": "number" },
                    "y": { "type": "number" }
                }
            })),
        t("android_swipe", "Swipe on the Android screen",
            json!({
                "type": "object",
                "required": ["start_x","start_y","end_x","end_y"],
                "properties": {
                    "start_x":    { "type": "number" },
                    "start_y":    { "type": "number" },
                    "end_x":      { "type": "number" },
                    "end_y":      { "type": "number" },
                    "duration_ms":{ "type": "integer", "default": 300 }
                }
            })),
        t("android_type_text", "Type text on the Android device",
            json!({
                "type": "object",
                "required": ["text"],
                "properties": { "text": { "type": "string" } }
            })),
        t("android_press_key", "Press a keycode on the Android device",
            json!({
                "type": "object",
                "required": ["keycode"],
                "properties": { "keycode": { "type": "integer" } }
            })),
        t("android_find_text", "Find text in the Android UI hierarchy",
            json!({
                "type": "object",
                "required": ["text"],
                "properties": {
                    "text":       { "type": "string" },
                    "exact":      { "type": "boolean", "default": false }
                }
            })),
        t("android_list_apps", "List installed apps on the Android device", json!({ "type": "object", "properties": {} })),
        t("android_launch_app", "Launch an app on the Android device",
            json!({
                "type": "object",
                "required": ["package"],
                "properties": {
                    "package":  { "type": "string" },
                    "activity": { "type": "string" }
                }
            })),
        t("android_get_display_info", "Get display metrics of the Android device", json!({ "type": "object", "properties": {} })),
        t("android_get_current_activity", "Get the foreground activity on the Android device", json!({ "type": "object", "properties": {} })),

        // ── App Protocol
        t("app_connect", "Connect to an Electron/native app via WebSocket protocol",
            json!({
                "type": "object",
                "required": ["url"],
                "properties": {
                    "url":                   { "type": "string" },
                    "expected_bundle_id":    { "type": "string" },
                    "expected_app_name":     { "type": "string" }
                }
            })),
        t("app_disconnect", "Disconnect from the connected app", json!({ "type": "object", "properties": {} })),
        t("app_get_info", "Get runtime info of the connected app", json!({ "type": "object", "properties": {} })),
        t("app_get_tree", "Get the UI element tree from the connected app",
            json!({
                "type": "object",
                "properties": {
                    "depth":   { "type": "integer", "default": 5 },
                    "root_id": { "type": "string" }
                }
            })),
        t("app_query", "Query UI elements using a selector in the connected app",
            json!({
                "type": "object",
                "required": ["selector"],
                "properties": {
                    "selector":   { "type": "string" },
                    "root_id":    { "type": "string" },
                    "max_results":{ "type": "integer", "default": 20 }
                }
            })),
        t("app_get_element", "Get details of a specific element by ID",
            json!({
                "type": "object",
                "required": ["element_id"],
                "properties": { "element_id": { "type": "string" } }
            })),
        t("app_click", "Click an element in the connected app",
            json!({
                "type": "object",
                "required": ["element_id"],
                "properties": { "element_id": { "type": "string" } }
            })),
        t("app_type", "Type text into an element in the connected app",
            json!({
                "type": "object",
                "required": ["element_id", "text"],
                "properties": {
                    "element_id": { "type": "string" },
                    "text":       { "type": "string" }
                }
            })),
        t("app_press_key", "Press a key in the connected app",
            json!({
                "type": "object",
                "required": ["key"],
                "properties": {
                    "key":       { "type": "string" },
                    "modifiers": { "type": "array", "items": { "type": "string" } }
                }
            })),
        t("app_focus", "Focus an element in the connected app",
            json!({
                "type": "object",
                "required": ["element_id"],
                "properties": { "element_id": { "type": "string" } }
            })),
        t("app_screenshot", "Take a screenshot from the connected app",
            json!({
                "type": "object",
                "properties": {
                    "element_id": { "type": "string" },
                    "format":     { "type": "string", "enum": ["jpeg","png"], "default": "jpeg" }
                }
            })),
        t("app_list_windows", "List windows in the connected app", json!({ "type": "object", "properties": {} })),
        t("app_focus_window", "Focus a window in the connected app",
            json!({
                "type": "object",
                "required": ["window_id"],
                "properties": { "window_id": { "type": "string" } }
            })),

        // ── Hover tracking
        t("start_hover_tracking", "Start tracking cursor hover events over UI elements",
            json!({
                "type": "object",
                "properties": {
                    "app_name":        { "type": "string" },
                    "poll_interval_ms":{ "type": "integer", "default": 100 },
                    "max_duration_ms": { "type": "integer", "default": 60000 },
                    "min_dwell_ms":    { "type": "integer", "default": 200 }
                }
            })),
        t("get_hover_events", "Get accumulated hover events since last call", json!({ "type": "object", "properties": {} })),
        t("stop_hover_tracking", "Stop hover tracking and return all remaining events", json!({ "type": "object", "properties": {} })),

        // ── Screen recording
        t("start_recording", "Start recording window screenshots to disk",
            json!({
                "type": "object",
                "required": ["output_dir"],
                "properties": {
                    "output_dir":    { "type": "string" },
                    "fps":           { "type": "integer", "default": 5 },
                    "max_duration_ms":{ "type": "integer", "default": 300000 }
                }
            })),
        t("stop_recording", "Stop screen recording and return list of recorded frames", json!({ "type": "object", "properties": {} })),
    ];

    // ── CDP tools (always listed; cdp_connect/disconnect are always available)
    #[cfg(feature = "cdp")]
    tools.extend(cdp_tool_list());

    tools
}

#[cfg(feature = "cdp")]
fn cdp_tool_list() -> Vec<Tool> {
    vec![
        t("cdp_connect", "Connect to a Chrome/Electron app via remote debugging port",
            json!({
                "type": "object",
                "required": ["port"],
                "properties": { "port": { "type": "integer" } }
            })),
        t("cdp_disconnect", "Disconnect from the CDP session", json!({ "type": "object", "properties": {} })),
        t("cdp_take_dom_snapshot", "Take a labeled DOM snapshot for element targeting",
            json!({
                "type": "object",
                "properties": { "max_nodes": { "type": "integer", "default": 500 } }
            })),
        t("cdp_summarize_page", "Get a concise text summary of the current page", json!({ "type": "object", "properties": {} })),
        t("cdp_find_elements", "Find DOM elements matching a text query in the snapshot",
            json!({
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query":       { "type": "string" },
                    "max_results": { "type": "integer", "default": 20 }
                }
            })),
        t("cdp_get_element_context", "Get full context of a DOM element by UID",
            json!({
                "type": "object",
                "required": ["uid"],
                "properties": { "uid": { "type": "string" } }
            })),
        t("cdp_evaluate_script", "Evaluate JavaScript in the current page context",
            json!({
                "type": "object",
                "required": ["script"],
                "properties": {
                    "script":           { "type": "string" },
                    "include_snapshot": { "type": "boolean", "default": false }
                }
            })),
        t("cdp_click", "Click a DOM element by UID",
            json!({
                "type": "object",
                "required": ["uid"],
                "properties": {
                    "uid":              { "type": "string" },
                    "double_click":     { "type": "boolean", "default": false },
                    "include_snapshot": { "type": "boolean", "default": false }
                }
            })),
        t("cdp_hover", "Hover over a DOM element by UID",
            json!({
                "type": "object",
                "required": ["uid"],
                "properties": {
                    "uid":              { "type": "string" },
                    "include_snapshot": { "type": "boolean", "default": false }
                }
            })),
        t("cdp_fill", "Fill/set the value of a form element by UID",
            json!({
                "type": "object",
                "required": ["uid", "value"],
                "properties": {
                    "uid":              { "type": "string" },
                    "value":            { "type": "string" },
                    "include_snapshot": { "type": "boolean", "default": false }
                }
            })),
        t("cdp_press_key", "Press a key on a focused DOM element",
            json!({
                "type": "object",
                "required": ["uid", "key"],
                "properties": {
                    "uid":              { "type": "string" },
                    "key":              { "type": "string" },
                    "include_snapshot": { "type": "boolean", "default": false }
                }
            })),
        t("cdp_type_text", "Type text into a DOM element",
            json!({
                "type": "object",
                "required": ["uid", "text"],
                "properties": {
                    "uid":              { "type": "string" },
                    "text":             { "type": "string" },
                    "include_snapshot": { "type": "boolean", "default": false }
                }
            })),
        t("cdp_list_pages", "List all open pages/tabs in the CDP session", json!({ "type": "object", "properties": {} })),
        t("cdp_select_page", "Select a page/tab to operate on",
            json!({
                "type": "object",
                "required": ["page_index"],
                "properties": { "page_index": { "type": "integer" } }
            })),
        t("cdp_navigate", "Navigate the current page to a URL",
            json!({
                "type": "object",
                "required": ["url"],
                "properties": { "url": { "type": "string" } }
            })),
        t("cdp_new_page", "Open a new page/tab",
            json!({
                "type": "object",
                "properties": { "url": { "type": "string" } }
            })),
        t("cdp_close_page", "Close a page/tab",
            json!({
                "type": "object",
                "properties": { "page_index": { "type": "integer" } }
            })),
        t("cdp_handle_dialog", "Accept or dismiss a JS dialog (alert/confirm/prompt)",
            json!({
                "type": "object",
                "properties": {
                    "accept":      { "type": "boolean", "default": true },
                    "prompt_text": { "type": "string" }
                }
            })),
        t("cdp_wait_for", "Wait for a CSS selector to appear in the DOM",
            json!({
                "type": "object",
                "required": ["selector"],
                "properties": {
                    "selector":   { "type": "string" },
                    "timeout_ms": { "type": "integer", "default": 5000 }
                }
            })),
        t("cdp_wait_for_page_change", "Wait for a page navigation to complete",
            json!({
                "type": "object",
                "properties": { "timeout_ms": { "type": "integer", "default": 5000 } }
            })),
        t("cdp_element_at_point", "Find the DOM element at screen coordinates",
            json!({
                "type": "object",
                "required": ["x", "y"],
                "properties": {
                    "x":                { "type": "number" },
                    "y":                { "type": "number" },
                    "include_snapshot": { "type": "boolean", "default": false }
                }
            })),
    ]
}
