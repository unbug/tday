//! Chrome DevTools Protocol (CDP) client for browser / Electron automation.
//!
//! Connects to Chrome / Electron apps via their `--remote-debugging-port`
//! using the `chromiumoxide` crate.

pub mod dom_discovery;
pub mod tools;

use chromiumoxide::browser::Browser;
use chromiumoxide::page::Page;
use futures_util::StreamExt;
use rmcp::model::{CallToolResult, Content};
use std::collections::HashMap;
use tokio::task::JoinHandle;

pub const DOM_UID_PREFIX: &str = "d";

/// CDP client state, owned by the MCP server.
pub struct CdpClient {
    pub browser: Browser,
    pub selected_page: Option<Page>,
    pub handler_handle: JoinHandle<()>,
    pub last_dom_snapshot: Option<SnapshotMap>,
    pub last_page_list: Vec<Page>,
    /// Monotonic counter bumped on every page-lifecycle event that could
    /// invalidate the `backendNodeId` space.
    pub generation: u64,
}

impl CdpClient {
    /// Connect to a Chrome/Electron instance via its remote debugging port.
    pub async fn connect(port: u16) -> Result<Self, String> {
        let url = format!("http://127.0.0.1:{port}");
        let (mut browser, mut handler) = Browser::connect(&url)
            .await
            .map_err(|e| format!("Cannot connect to port {port}. Is the app running with --remote-debugging-port? Error: {e}"))?;

        let handler_handle =
            tokio::spawn(async move { while handler.next().await.is_some() {} });

        let selected_page =
            poll_for_page(&mut browser, std::time::Duration::from_secs(10)).await?;

        Ok(Self {
            browser,
            selected_page,
            handler_handle,
            last_dom_snapshot: None,
            last_page_list: Vec::new(),
            generation: 0,
        })
    }

    /// Disconnect from the browser by aborting the handler task.
    pub fn disconnect(self) {
        self.handler_handle.abort();
    }

    /// Invalidate DOM snapshot cache and bump generation counter.
    pub fn invalidate_snapshots(&mut self) {
        self.last_dom_snapshot = None;
        self.generation = self.generation.wrapping_add(1);
    }

    /// Get the selected page, or return a tool error.
    pub fn require_page(&self) -> Result<Page, CallToolResult> {
        self.selected_page.clone().ok_or_else(|| {
            cdp_error("No page selected. Use cdp_list_pages and cdp_select_page first.")
        })
    }
}

/// Return the URL of a page (empty string on failure).
pub async fn page_url(page: &Page) -> String {
    page.url().await.ok().flatten().unwrap_or_default()
}

/// Return true if the URL belongs to a Chrome extension.
pub(crate) fn is_extension_url(url: &str) -> bool {
    url.starts_with("chrome-extension://")
}

/// Find the first non-extension page in a list.
async fn first_non_extension_page(pages: &[Page]) -> Option<Page> {
    for page in pages {
        if !is_extension_url(&page_url(page).await) {
            return Some(page.clone());
        }
    }
    None
}

/// Wait for at least one non-extension page to become available.
async fn poll_for_page(
    browser: &mut Browser,
    timeout: std::time::Duration,
) -> Result<Option<Page>, String> {
    let _ = browser.fetch_targets().await;
    let interval = std::time::Duration::from_millis(100);
    let start    = std::time::Instant::now();
    loop {
        let pages = browser
            .pages()
            .await
            .map_err(|e| format!("Failed to list pages: {e}"))?;
        if let Some(page) = first_non_extension_page(&pages).await {
            return Ok(Some(page));
        }
        if start.elapsed() >= timeout {
            return Ok(None);
        }
        tokio::time::sleep(interval).await;
    }
}

/// Build a CDP tool error result.
pub fn cdp_error(msg: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![Content::text(msg.into())])
}

/// Snapshot of the page DOM, keyed by `d<N>` UIDs.
pub struct SnapshotMap {
    pub uid_to_node:      HashMap<String, SnapshotNode>,
    pub uid_to_candidate: HashMap<String, dom_discovery::DomCandidate>,
    pub backend_to_uids:  HashMap<i64, Vec<String>>,
    pub ordered_uids:     Vec<String>,
    pub page_url:         String,
    pub generation:       u64,
}

pub struct SnapshotNode {
    pub backend_node_id: i64,
    pub role:            String,
    pub name:            String,
}

/// Resolve a `d<N>` UID to its [`SnapshotNode`].
///
/// Returns an error when the UID prefix is wrong, the snapshot is missing or
/// stale (generation bumped or page URL changed), or the UID is not found.
pub fn resolve_uid<'a>(
    uid: &str,
    snapshot: Option<&'a SnapshotMap>,
    generation: u64,
    current_url: &str,
) -> Result<&'a SnapshotNode, String> {
    if !uid.starts_with(DOM_UID_PREFIX) {
        return Err(format!(
            "Unknown UID prefix in '{uid}'. Expected 'd<N>' (DOM)."
        ));
    }
    let snap = snapshot.ok_or(
        "No DOM snapshot. Call cdp_take_dom_snapshot or cdp_find_elements first.",
    )?;
    if snap.generation != generation {
        return Err(
            "Snapshot is stale (page navigation detected). Take a fresh snapshot.".to_string(),
        );
    }
    if snap.page_url != current_url {
        return Err(format!(
            "Snapshot is stale: taken on '{}', current page is '{current_url}'.",
            snap.page_url
        ));
    }
    snap.uid_to_node
        .get(uid)
        .ok_or_else(|| format!("UID '{uid}' not found in snapshot."))
}
