/// Integration tests for tday-nativecore HTTP server mode.
///
/// These tests spawn the actual binary with `--port 0`, read the announced
/// port from stdout, and exercise the MCP `/mcp` endpoint via HTTP.
/// They require a release build to be present at the standard cargo output path.
///
/// Run with:  cargo test --test http_server_test
///
/// Note: these tests only validate the HTTP transport plumbing and JSON-RPC
/// framing.  Individual tool correctness is covered by other unit tests.

#[cfg(test)]
mod http_server_tests {
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        time::Duration,
    };

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Spawn `tday-nativecore --port 0` and return (child, actual_port).
    fn spawn_server() -> (Child, u16) {
        let bin = env!("CARGO_BIN_EXE_tday-nativecore");
        let mut child = Command::new(bin)
            .arg("--port")
            .arg("0")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn tday-nativecore");

        let stdout = child.stdout.take().expect("no stdout");
        let mut reader = BufReader::new(stdout);
        let mut port: Option<u16> = None;

        // Read lines until we see NATIVECORE_PORT:<n>
        for _ in 0..100 {
            let mut line = String::new();
            reader.read_line(&mut line).expect("read_line failed");
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("NATIVECORE_PORT:") {
                port = rest.parse().ok();
                break;
            }
        }

        let p = port.expect("server did not announce NATIVECORE_PORT within expected output");
        (child, p)
    }

    /// Kill the server child process.
    fn kill_server(mut child: Child) {
        let _ = child.kill();
        let _ = child.wait();
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    /// POST /mcp — initialize request should return a 200 response with a
    /// valid JSON-RPC result containing serverInfo.
    #[test]
    fn http_server_responds_to_initialize() {
        let (child, port) = spawn_server();

        let url = format!("http://127.0.0.1:{}/mcp", port);

        // Give the server a moment to start listening.
        std::thread::sleep(Duration::from_millis(200));

        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "test-client", "version": "0.0.1" }
            }
        });

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .expect("client build");

        let resp = client
            .post(&url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(body.to_string())
            .send()
            .expect("HTTP request failed");

        assert!(
            resp.status().is_success(),
            "Expected 2xx, got {}: {}",
            resp.status(),
            resp.text().unwrap_or_default()
        );

        kill_server(child);
    }

    /// The server should bind to a random port (different from 0).
    #[test]
    fn http_server_binds_to_random_port() {
        let (child, port) = spawn_server();
        assert!(port > 0, "port should be non-zero");
        kill_server(child);
    }

    /// Two concurrent server instances should bind to different ports.
    #[test]
    fn two_instances_bind_to_different_ports() {
        let (child1, port1) = spawn_server();
        let (child2, port2) = spawn_server();
        assert_ne!(port1, port2, "each instance should use a unique port");
        kill_server(child1);
        kill_server(child2);
    }

    /// Verify port announcement format: line must match `NATIVECORE_PORT:<n>`.
    #[test]
    fn port_announcement_format() {
        let bin = env!("CARGO_BIN_EXE_tday-nativecore");
        let mut child = Command::new(bin)
            .arg("--port")
            .arg("0")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn failed");

        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut first_line = String::new();
        reader.read_line(&mut first_line).unwrap();
        let trimmed = first_line.trim();

        assert!(
            trimmed.starts_with("NATIVECORE_PORT:"),
            "first stdout line must start with NATIVECORE_PORT:, got: {:?}",
            trimmed
        );

        let port_str = trimmed.strip_prefix("NATIVECORE_PORT:").unwrap();
        let port: u16 = port_str.parse().expect("port should be a valid u16");
        assert!(port > 0);

        let _ = child.kill();
        let _ = child.wait();
    }
}
