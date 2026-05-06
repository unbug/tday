// Suppress deprecated-API warnings that come from cocoa / objc macros.
#![allow(deprecated)]

/// JPEG quality used for window / screen captures.
pub const JPEG_QUALITY: u8 = 80;

pub(crate) mod android;
pub(crate) mod app_protocol;
#[cfg(feature = "cdp")]
pub(crate) mod cdp;
mod error;
mod find_image;
mod handlers;
mod platform;
mod server;
mod session;
pub(crate) mod tracking;

pub use error::{DevToolsError, Result};
pub use server::DevToolsServer;
