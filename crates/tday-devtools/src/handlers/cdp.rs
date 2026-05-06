//! CDP (Chrome DevTools Protocol) handlers — thin bridge from server dispatch
//! to the cdp::tools functions.

pub use crate::cdp::CdpClient;
use std::sync::Arc;
use tokio::sync::RwLock;

#[allow(dead_code)]
pub type SharedCdpClient = Arc<RwLock<Option<CdpClient>>>;
