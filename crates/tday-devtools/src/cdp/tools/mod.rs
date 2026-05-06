//! CDP tool implementations grouped by concern.
//! - `input`  : click, hover, fill, press_key, type_text
//! - `pages`  : list/select/navigate/open/close pages, handle dialogs
//! - `script` : evaluate_script, take_dom_snapshot, find_elements, wait_for
//! - `element_at_point`: screen coordinates → snapshot UIDs

pub mod element_at_point;
pub mod input;
pub mod pages;
pub mod script;

pub use element_at_point::cdp_element_at_point;
pub use input::{cdp_click, cdp_fill, cdp_hover, cdp_press_key, cdp_type_text};
pub use pages::{
    cdp_close_page, cdp_handle_dialog, cdp_list_pages, cdp_navigate, cdp_new_page,
    cdp_select_page,
};
pub use script::{
    cdp_evaluate_script, cdp_find_elements, cdp_get_element_context, cdp_summarize_page,
    cdp_take_dom_snapshot, cdp_wait_for, cdp_wait_for_page_change,
};

// ─── Shared resolution helpers used by input / element tools ─────────────────

use crate::cdp::{cdp_error, CdpClient};
use chromiumoxide::cdp::browser_protocol::dom::{
    BackendNodeId, GetBoxModelParams, ResolveNodeParams, ScrollIntoViewIfNeededParams,
};
use chromiumoxide::page::Page;
use rmcp::model::CallToolResult;

/// Resolve a UID to a `(backend_node_id, role, name)` tuple.
///
/// Detects stale snapshots by checking `generation` and current page URL.
pub(super) fn resolve_node(
    uid: &str,
    client: &CdpClient,
    current_url: &str,
) -> Result<(BackendNodeId, String, String), CallToolResult> {
    let node = crate::cdp::resolve_uid(
        uid,
        client.last_dom_snapshot.as_ref(),
        client.generation,
        current_url,
    )
    .map_err(cdp_error)?;

    Ok((
        BackendNodeId::new(node.backend_node_id),
        node.role.clone(),
        node.name.clone(),
    ))
}

/// Resolve a `BackendNodeId` to a JS remote object ID for `callFunctionOn`.
pub(super) async fn resolve_to_object_id(
    uid: &str,
    backend_node_id: BackendNodeId,
    page: &Page,
) -> Result<chromiumoxide::cdp::js_protocol::runtime::RemoteObjectId, CallToolResult> {
    let params = ResolveNodeParams::builder()
        .backend_node_id(backend_node_id)
        .build();
    let remote = page.execute(params).await.map_err(|e| {
        cdp_error(format!(
            "Element uid={uid} could not be resolved to a DOM node: {e}"
        ))
    })?;
    remote.result.object.object_id.ok_or_else(|| {
        cdp_error(format!(
            "Element uid={uid} could not be resolved to a DOM node."
        ))
    })
}

/// Resolve a UID to the element's screen-space centre coordinates.
/// Scrolls the element into view first.
pub(super) async fn resolve_element_center(
    uid: &str,
    client: &CdpClient,
    page: &Page,
) -> Result<(String, String, f64, f64), CallToolResult> {
    let current_url = crate::cdp::page_url(page).await;
    let (bnid, role, name) = resolve_node(uid, client, &current_url)?;

    // Scroll into view.
    if let Err(e) = page
        .execute(ScrollIntoViewIfNeededParams::builder().backend_node_id(bnid).build())
        .await
    {
        return Err(cdp_error(format!(
            "Failed to scroll element uid={uid} into view: {e}"
        )));
    }

    // Get bounding box.
    let box_result = page
        .execute(GetBoxModelParams::builder().backend_node_id(bnid).build())
        .await
        .map_err(|e| cdp_error(format!("Element uid={uid} is no longer in the DOM: {e}")))?;

    let quad = box_result.result.model.content.inner();
    if quad.len() < 8 {
        return Err(cdp_error(format!(
            "Element uid={uid} returned an invalid box model."
        )));
    }
    let cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4.0;
    let cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4.0;
    Ok((role, name, cx, cy))
}
