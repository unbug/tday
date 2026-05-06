//! CDP page management tools.

use crate::cdp::{cdp_error, is_extension_url, page_url, CdpClient};
use chromiumoxide::cdp::browser_protocol::page::{
    GetNavigationHistoryParams, HandleJavaScriptDialogParams, NavigateParams,
    NavigateToHistoryEntryParams, ReloadParams,
};
use rmcp::model::{CallToolResult, Content};
use std::sync::Arc;
use tokio::sync::RwLock;

const DEFAULT_NAV_TIMEOUT_MS: u64 = 10_000;

pub async fn cdp_list_pages(cdp_client: Arc<RwLock<Option<CdpClient>>>) -> CallToolResult {
    let mut guard = cdp_client.write().await;
    let client = match guard.as_mut() {
        Some(c) => c,
        None => return cdp_error("No CDP connection. Use cdp_connect first."),
    };

    let pages = match client.browser.pages().await {
        Ok(p) => p,
        Err(e) => return cdp_error(format!("Failed to list pages: {e}")),
    };

    let mut filtered: Vec<chromiumoxide::page::Page> = Vec::new();
    let mut urls: Vec<String> = Vec::new();
    for page in pages {
        let url = page_url(&page).await;
        if !is_extension_url(&url) {
            filtered.push(page);
            urls.push(url);
        }
    }

    let selected_target = client.selected_page.as_ref().map(|p| p.target_id().clone());
    let total = filtered.len();
    let mut out = format!("Pages ({total} total):\n");
    for (i, page) in filtered.iter().enumerate() {
        let marker = if selected_target.as_ref().is_some_and(|id| id == page.target_id()) { " *" } else { "" };
        out.push_str(&format!("  [{i}]{marker} {}\n", urls[i]));
    }
    client.last_page_list = filtered;
    CallToolResult::success(vec![Content::text(out.trim_end().to_string())])
}

pub async fn cdp_select_page(
    page_idx: usize,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let mut guard = cdp_client.write().await;
    let client = match guard.as_mut() {
        Some(c) => c,
        None => return cdp_error("No CDP connection. Use cdp_connect first."),
    };
    if client.last_page_list.is_empty() {
        return cdp_error("No page list. Call cdp_list_pages first.");
    }
    if page_idx >= client.last_page_list.len() {
        return cdp_error(format!("Page index {page_idx} out of range. Call cdp_list_pages to refresh."));
    }
    let page = client.last_page_list[page_idx].clone();
    let same = client.selected_page.as_ref().is_some_and(|s| s.target_id() == page.target_id());
    if let Err(e) = page.bring_to_front().await {
        return cdp_error(format!("Failed to bring page {page_idx} to front: {e}"));
    }
    let url = page_url(&page).await;
    client.selected_page = Some(page);
    if !same { client.invalidate_snapshots(); }
    CallToolResult::success(vec![Content::text(format!("Selected page [{page_idx}]: {url}"))])
}

pub async fn cdp_handle_dialog(
    action: String,
    prompt_text: Option<String>,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() {
        Some(c) => c,
        None => return cdp_error("No CDP connection. Use cdp_connect first."),
    };
    let page = match client.require_page() {
        Ok(p) => p,
        Err(e) => return e,
    };
    drop(guard);

    let accept = match action.as_str() {
        "accept"  => true,
        "dismiss" => false,
        _ => return cdp_error(format!("Invalid action '{action}'. Use 'accept' or 'dismiss'.")),
    };
    let detail = prompt_text.as_deref().map(|t| format!(" with text '{t}'")).unwrap_or_default();
    let mut params = HandleJavaScriptDialogParams::new(accept);
    params.prompt_text = prompt_text;
    match page.execute(params).await {
        Ok(_)  => CallToolResult::success(vec![Content::text(format!("Dialog {action}ed{detail}"))]),
        Err(e) => cdp_error(format!("Failed to handle dialog: {e}")),
    }
}

pub async fn cdp_navigate(
    url: Option<String>,
    nav_type: Option<String>,
    timeout_ms: Option<u64>,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let mut guard = cdp_client.write().await;
    let client = match guard.as_mut() {
        Some(c) => c,
        None => return cdp_error("No CDP connection. Use cdp_connect first."),
    };
    let page = match client.require_page() {
        Ok(p) => p,
        Err(e) => return e,
    };

    match nav_type.as_deref().unwrap_or("url") {
        "url" => {
            let target = match &url {
                Some(u) => u.clone(),
                None => return cdp_error("'url' parameter required when type is 'url'."),
            };
            let nav_timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_NAV_TIMEOUT_MS));
            match tokio::time::timeout(nav_timeout, page.execute(NavigateParams::new(&target))).await {
                Ok(Ok(resp)) => {
                    if let Some(err) = &resp.result.error_text {
                        return cdp_error(format!("Navigation to {target} failed: {err}"));
                    }
                    if resp.result.is_download == Some(true) {
                        return cdp_error(format!("Navigation to {target} triggered a download."));
                    }
                    client.invalidate_snapshots();
                    CallToolResult::success(vec![Content::text(format!("Navigated to {target}"))])
                }
                Ok(Err(e)) => cdp_error(format!("Navigation failed: {e}")),
                Err(_) => {
                    client.invalidate_snapshots();
                    CallToolResult::success(vec![Content::text(format!("Navigated to {target} (page may still be loading)"))])
                }
            }
        }
        "reload" => match page.execute(ReloadParams::default()).await {
            Ok(_)  => { client.invalidate_snapshots(); CallToolResult::success(vec![Content::text("Page reloaded")]) }
            Err(e) => cdp_error(format!("Reload failed: {e}")),
        },
        action @ ("back" | "forward") => {
            let history = match page.execute(GetNavigationHistoryParams::default()).await {
                Ok(r)  => r.result,
                Err(e) => return cdp_error(format!("Failed to get history: {e}")),
            };
            let idx = if action == "back" { history.current_index - 1 } else { history.current_index + 1 };
            if idx < 0 || idx as usize >= history.entries.len() {
                return cdp_error(format!("No {action} history available."));
            }
            let entry = &history.entries[idx as usize];
            let entry_id  = entry.id;
            let entry_url = entry.url.clone();
            match page.execute(NavigateToHistoryEntryParams::new(entry_id)).await {
                Ok(_)  => { client.invalidate_snapshots(); CallToolResult::success(vec![Content::text(format!("Navigated {action}: {entry_url}"))]) }
                Err(e) => cdp_error(format!("Navigation {action} failed: {e}")),
            }
        }
        other => cdp_error(format!("Invalid type '{other}'. Use 'url', 'back', 'forward', or 'reload'.")),
    }
}

pub async fn cdp_new_page(
    url: String,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let mut guard = cdp_client.write().await;
    let client = match guard.as_mut() {
        Some(c) => c,
        None => return cdp_error("No CDP connection. Use cdp_connect first."),
    };
    match client.browser.new_page(&url).await {
        Ok(page) => {
            let pu = page_url(&page).await;
            client.selected_page = Some(page);
            client.invalidate_snapshots();
            CallToolResult::success(vec![Content::text(format!("Created and selected new page: {pu}"))])
        }
        Err(e) => cdp_error(format!("Failed to create new page: {e}")),
    }
}

pub async fn cdp_close_page(
    page_idx: usize,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let mut guard = cdp_client.write().await;
    let client = match guard.as_mut() {
        Some(c) => c,
        None => return cdp_error("No CDP connection. Use cdp_connect first."),
    };
    if client.last_page_list.is_empty() {
        return cdp_error("No page list. Call cdp_list_pages first.");
    }
    if client.last_page_list.len() <= 1 {
        return cdp_error("Cannot close the last open page.");
    }
    if page_idx >= client.last_page_list.len() {
        return cdp_error(format!("Page index {page_idx} out of range."));
    }

    let page_to_close = client.last_page_list[page_idx].clone();
    let url = page_to_close.url().await.ok().flatten().unwrap_or_default();
    let is_selected = client.selected_page.as_ref()
        .is_some_and(|s| s.target_id() == page_to_close.target_id());

    if let Err(e) = page_to_close.close().await {
        return cdp_error(format!("Failed to close page [{page_idx}]: {e}"));
    }
    client.last_page_list.remove(page_idx);

    if is_selected {
        client.invalidate_snapshots();
        let new_idx = if page_idx < client.last_page_list.len() { page_idx } else { client.last_page_list.len().saturating_sub(1) };
        if let Some(rep) = client.last_page_list.get(new_idx) {
            client.selected_page = if rep.bring_to_front().await.is_ok() { Some(rep.clone()) } else { None };
        } else {
            client.selected_page = None;
        }
    }
    CallToolResult::success(vec![Content::text(format!("Closed page [{page_idx}]: {url}"))])
}
