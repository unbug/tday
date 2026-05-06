//! CDP `cdp_element_at_point` — resolve screen coordinates to a snapshot UID.

use std::sync::Arc;
use tokio::sync::RwLock;

use chromiumoxide::cdp::browser_protocol::dom::{GetNodeForLocationParams};
use chromiumoxide::cdp::js_protocol::runtime::EvaluateParams;
use rmcp::model::{CallToolResult, Content};

use crate::cdp::CdpClient;

/// Find the DOM element at screen-space coordinates and return its snapshot UID.
pub async fn cdp_element_at_point(
    x: f64,
    y: f64,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() {
        Some(c) => c,
        None => return CallToolResult::error(vec![Content::text("No CDP connection. Use cdp_connect first.")]),
    };
    let page = match client.require_page() {
        Ok(p) => p,
        Err(e) => return e,
    };

    // Query window geometry.
    let geo = match query_window_geometry(&page).await {
        Ok(g) => g,
        Err(e) => return CallToolResult::error(vec![Content::text(e)]),
    };

    let chrome_h  = geo.outer_height - geo.inner_height;
    let viewport_x = x - geo.screen_x;
    let viewport_y = y - geo.screen_y - chrome_h;

    if viewport_x < 0.0 || viewport_y < 0.0
        || viewport_x >= geo.inner_width
        || viewport_y >= geo.inner_height
    {
        return CallToolResult::error(vec![Content::text(format!(
            "Screen point ({x}, {y}) → viewport ({viewport_x:.0}, {viewport_y:.0}) is \
             outside the content area ({}×{}). Point may be in the title bar or chrome.",
            geo.inner_width, geo.inner_height
        ))]);
    }

    let page_x = viewport_x + geo.scroll_x;
    let page_y = viewport_y + geo.scroll_y;

    // Hit-test via CDP.
    let backend_node_id = match get_node_for_location(&page, page_x, page_y).await {
        Ok(id) => id,
        Err(_) => match element_from_point_fallback(&page, viewport_x, viewport_y).await {
            Ok(id) => id,
            Err(e) => return CallToolResult::error(vec![Content::text(format!(
                "No element found at ({x}, {y}): {e}"
            ))]),
        },
    };

    let current_url = crate::cdp::page_url(&page).await;
    match find_uid_in_snapshot(client, backend_node_id, &current_url) {
        Some((uid, role, name)) => {
            let json = serde_json::json!({ "uid": uid, "role": role, "name": name,
                                           "backend_node_id": backend_node_id });
            CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&json).unwrap_or_default(),
            )])
        }
        None => {
            let json = serde_json::json!({
                "uid": null,
                "backend_node_id": backend_node_id,
                "note": "Element not in DOM snapshot. Call cdp_take_dom_snapshot first.",
            });
            CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&json).unwrap_or_default(),
            )])
        }
    }
}

fn find_uid_in_snapshot(
    client: &CdpClient,
    backend_node_id: i64,
    current_url: &str,
) -> Option<(String, String, String)> {
    let snap = client.last_dom_snapshot.as_ref()?;
    if snap.generation != client.generation || snap.page_url != current_url {
        return None;
    }
    let uids = snap.backend_to_uids.get(&backend_node_id)?;
    let uid  = uids.first()?;
    let node = snap.uid_to_node.get(uid)?;
    Some((uid.clone(), node.role.clone(), node.name.clone()))
}

struct WindowGeometry {
    screen_x: f64, screen_y: f64,
    outer_height: f64,
    inner_width: f64, inner_height: f64,
    scroll_x: f64,  scroll_y: f64,
}

async fn query_window_geometry(page: &chromiumoxide::Page) -> Result<WindowGeometry, String> {
    let js = "JSON.stringify([window.screenX, window.screenY, window.outerHeight, \
              window.innerWidth, window.innerHeight, window.scrollX, window.scrollY])";
    let mut params = EvaluateParams::new(js);
    params.return_by_value = Some(true);
    let result = page.execute(params).await
        .map_err(|e| format!("Failed to query window geometry: {e}"))?;
    let raw = result.result.result.value.as_ref()
        .and_then(|v| v.as_str())
        .ok_or("Empty geometry response")?;
    let vals: Vec<f64> = serde_json::from_str(raw)
        .map_err(|e| format!("Failed to parse geometry: {e}"))?;
    if vals.len() < 7 {
        return Err(format!("Expected 7 geometry values, got {}", vals.len()));
    }
    Ok(WindowGeometry {
        screen_x: vals[0], screen_y: vals[1], outer_height: vals[2],
        inner_width: vals[3], inner_height: vals[4],
        scroll_x: vals[5], scroll_y: vals[6],
    })
}

async fn get_node_for_location(
    page: &chromiumoxide::Page,
    page_x: f64,
    page_y: f64,
) -> Result<i64, String> {
    let params = GetNodeForLocationParams::new(page_x as i64, page_y as i64);
    let result = page.execute(params).await
        .map_err(|e| format!("DOM.getNodeForLocation failed: {e}"))?;
    Ok(*result.result.backend_node_id.inner())
}

async fn element_from_point_fallback(
    page: &chromiumoxide::Page,
    viewport_x: f64,
    viewport_y: f64,
) -> Result<i64, String> {
    let _js = format!(
        "(() => {{ const el = document.elementFromPoint({viewport_x},{viewport_y}); \
         if (!el) return null; const r = document.createRange(); \
         r.selectNode(el); return null; }})();"
    );
    // Try via CDP's Runtime.callFunctionOn on document
    let mut params = EvaluateParams::new(
        &format!("(function(){{ const el = document.elementFromPoint({viewport_x},{viewport_y}); return el ? el.tagName : null; }})()"),
    );
    params.return_by_value = Some(true);
    let _ = page.execute(params).await
        .map_err(|e| format!("elementFromPoint failed: {e}"))?;
    Err("Fallback did not return a backend node ID".to_string())
}
