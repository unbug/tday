// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

// Suppress deprecated-API warnings that come from cocoa / objc macros.
#![allow(deprecated)]

mod parent_watch;
mod singleton;

use tday_nativecore::DevToolsServer;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    match parse_port_arg(&args) {
        Some(port) => start_http_server(port),
        None       => start_stdio_server(),
    }
}

/// Parse `--port PORT` or `--port=PORT` from argv.  Returns 0 if no value follows,
/// which causes the OS to pick an ephemeral port.
fn parse_port_arg(args: &[String]) -> Option<u16> {
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--port" {
            return it.next().and_then(|v| v.parse().ok());
        }
        if let Some(val) = arg.strip_prefix("--port=") {
            return val.parse().ok();
        }
    }
    None
}

// ── Stdio mode (original) ─────────────────────────────────────────────────────

#[tokio::main]
async fn start_stdio_server() -> Result<(), Box<dyn std::error::Error>> {
    use rmcp::ServiceExt;
    use tokio::signal;
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    // Log to stderr — stdout carries the MCP JSON-RPC stream.
    tracing_subscriber::registry()
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(
            EnvFilter::from_default_env()
                .add_directive("tday_nativecore=info".parse()?),
        )
        .init();

    tracing::info!("Starting tday-nativecore MCP server (stdio)");

    // Primary: exit when our parent (agent CLI) dies so no zombie is left behind.
    parent_watch::start_watching();

    // Fallback: kill any truly orphaned (parent=init) process from a previous
    // session where parent_watch somehow failed to fire.
    let _singleton = singleton::acquire();

    let server  = DevToolsServer::new();
    let service = server.serve(rmcp::transport::stdio()).await?;

    tokio::select! {
        result = service.waiting() => { result?; }
        _ = signal::ctrl_c()       => { tracing::info!("SIGINT — shutting down"); }
    }

    tracing::info!("Server stopped");
    std::process::exit(0);
}

// ── HTTP mode (shared service for multi-agent) ────────────────────────────────

#[tokio::main]
async fn start_http_server(port: u16) -> Result<(), Box<dyn std::error::Error>> {
    use rmcp::transport::streamable_http_server::{
        session::local::LocalSessionManager,
        StreamableHttpServerConfig,
        StreamableHttpService,
    };
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio::signal;
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    // Log to stderr — stdout is reserved for the PORT announcement.
    tracing_subscriber::registry()
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(
            EnvFilter::from_default_env()
                .add_directive("tday_nativecore=info".parse()?),
        )
        .init();

    tracing::info!("Starting tday-nativecore HTTP MCP server (requested port={})", port);

    // Watch parent — exit when Electron main process dies.
    parent_watch::start_watching();

    // Bind before announcing so callers can connect immediately after reading the port.
    let listener = TcpListener::bind(format!("127.0.0.1:{}", port)).await?;
    let actual_port = listener.local_addr()?.port();

    // ── Announce actual port to parent (Electron) on stdout ──────────────────
    // Must be flushed before any other stdout output.
    {
        use std::io::Write;
        let mut out = std::io::stdout();
        writeln!(out, "NATIVECORE_PORT:{}", actual_port)?;
        out.flush()?;
    }

    tracing::info!("HTTP MCP server listening on 127.0.0.1:{}", actual_port);

    // ── Build HTTP service ────────────────────────────────────────────────────
    // Construct one DevToolsServer template. Every HTTP session clones it, so
    // all sessions share the same Arc<RwLock> → global read/write tool queue.
    let template = DevToolsServer::new();
    let service = StreamableHttpService::new(
        move || Ok(template.clone()),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );

    let router = axum::Router::new().nest_service("/mcp", service);

    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            signal::ctrl_c().await.ok();
            tracing::info!("SIGINT — HTTP server shutting down");
        })
        .await?;

    tracing::info!("HTTP server stopped");
    Ok(())
}
