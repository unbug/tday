/// System-level tools: wait, scrape, execute_command, clipboard, process management.

use crate::error::{DevToolsError, Result};
use serde_json::{json, Value};
use std::time::Duration;

// ──────────────────────────────────────────────────────────────────────────────
// wait
// ──────────────────────────────────────────────────────────────────────────────

/// Pause execution for a specified number of seconds.
pub async fn handle_wait(params: Value) -> Result<Value> {
    let secs = params.get("duration")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| DevToolsError::Input("duration (seconds) required".into()))?;
    if secs < 0.0 || secs > 300.0 {
        return Err(DevToolsError::Input("duration must be between 0 and 300 seconds".into()));
    }
    tokio::time::sleep(Duration::from_secs_f64(secs)).await;
    Ok(json!({ "ok": true, "waited_seconds": secs }))
}

// ──────────────────────────────────────────────────────────────────────────────
// scrape
// ──────────────────────────────────────────────────────────────────────────────

/// Fetch a URL and return the response body as text.
///
/// Uses a 15-second timeout. Follows redirects. Returns HTML/text content.
pub async fn handle_scrape(params: Value) -> Result<Value> {
    let url = params.get("url").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("url required".into()))?.to_string();

    // Validate URL scheme to prevent SSRF with file:// etc.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(DevToolsError::Input("url must start with http:// or https://".into()));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("tday-devtools/1.0 (macOS desktop automation)")
        .build()
        .map_err(|e| DevToolsError::Other(format!("http client: {e}")))?;

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| DevToolsError::Other(format!("request failed: {e}")))?;

    let status = resp.status().as_u16();
    let content_type = resp.headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await
        .map_err(|e| DevToolsError::Other(format!("reading body: {e}")))?;

    Ok(json!({
        "status":       status,
        "content_type": content_type,
        "body":         body,
        "length":       body.len(),
    }))
}

// ──────────────────────────────────────────────────────────────────────────────
// execute_command
// ──────────────────────────────────────────────────────────────────────────────

/// Execute a shell command or AppleScript and return stdout/stderr/exit_code.
///
/// Parameters:
///   command  – the command string to execute (required)
///   mode     – "shell" (default) or "osascript"
///   timeout  – seconds before killing the process (default 10, max 60)
pub async fn handle_execute_command(params: Value) -> Result<Value> {
    let command = params.get("command").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("command required".into()))?.to_string();
    let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("shell").to_string();
    let timeout_secs = params.get("timeout").and_then(|v| v.as_u64()).unwrap_or(10).min(60);

    let result = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        tokio::task::spawn_blocking(move || {
            let (prog, args): (&str, Vec<&str>) = match mode.as_str() {
                "osascript" => ("osascript", vec!["-e", &command]),
                _           => ("sh",        vec!["-c", &command]),
            };
            std::process::Command::new(prog)
                .args(&args)
                .output()
        }),
    )
    .await
    .map_err(|_| DevToolsError::Other(format!("command timed out after {timeout_secs}s")))?
    .map_err(|e| DevToolsError::Other(format!("spawn: {e}")))?
    .map_err(|e| DevToolsError::Other(format!("exec: {e}")))?;

    Ok(json!({
        "stdout":    String::from_utf8_lossy(&result.stdout).trim_end().to_string(),
        "stderr":    String::from_utf8_lossy(&result.stderr).trim_end().to_string(),
        "exit_code": result.status.code().unwrap_or(-1),
        "ok":        result.status.success(),
    }))
}

// ──────────────────────────────────────────────────────────────────────────────
// clipboard
// ──────────────────────────────────────────────────────────────────────────────

/// Get or set the macOS system clipboard.
///
/// mode = "get" — returns clipboard text content
/// mode = "set" — sets clipboard to `text`
pub async fn handle_clipboard(params: Value) -> Result<Value> {
    let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("get").to_string();

    match mode.as_str() {
        "get" => {
            let output = tokio::task::spawn_blocking(|| {
                std::process::Command::new("pbpaste").output()
            })
            .await.map_err(|e| DevToolsError::Other(format!("spawn: {e}")))?
            .map_err(|e| DevToolsError::Other(format!("pbpaste: {e}")))?;

            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            Ok(json!({ "text": text, "length": text.len() }))
        }
        "set" => {
            let text = params.get("text").and_then(|v| v.as_str())
                .ok_or_else(|| DevToolsError::Input("text required for mode=set".into()))?.to_string();
            tokio::task::spawn_blocking(move || {
                use std::process::{Command, Stdio};
                use std::io::Write;
                let mut child = Command::new("pbcopy")
                    .stdin(Stdio::piped())
                    .spawn()?;
                if let Some(stdin) = child.stdin.as_mut() {
                    stdin.write_all(text.as_bytes())?;
                }
                child.wait()
            })
            .await.map_err(|e| DevToolsError::Other(format!("spawn: {e}")))?
            .map_err(|e| DevToolsError::Other(format!("pbcopy: {e}")))?;
            Ok(json!({ "ok": true }))
        }
        other => Err(DevToolsError::Input(format!("unknown clipboard mode '{other}'; use get or set"))),
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// process
// ──────────────────────────────────────────────────────────────────────────────

/// List or kill OS processes.
///
/// mode = "list" — list running processes (optional: name filter, sort_by, limit)
/// mode = "kill" — kill a process by name or PID (optional: force)
pub async fn handle_process(params: Value) -> Result<Value> {
    let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("list").to_string();

    match mode.as_str() {
        "list" => {
            let name_filter = params.get("name").and_then(|v| v.as_str()).map(|s| s.to_lowercase());
            let sort_by = params.get("sort_by").and_then(|v| v.as_str()).unwrap_or("memory").to_string();
            let limit = params.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;

            let output = tokio::task::spawn_blocking(|| {
                std::process::Command::new("ps")
                    .args(["-axo", "pid,pcpu,pmem,comm"])
                    .output()
            })
            .await.map_err(|e| DevToolsError::Other(format!("spawn: {e}")))?
            .map_err(|e| DevToolsError::Other(format!("ps: {e}")))?;

            let stdout = String::from_utf8_lossy(&output.stdout);
            let mut procs: Vec<Value> = stdout.lines()
                .skip(1)  // skip header
                .filter_map(|line| {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() < 4 { return None; }
                    let pid:  i64 = parts[0].parse().ok()?;
                    let cpu:  f64 = parts[1].parse().ok()?;
                    let mem:  f64 = parts[2].parse().ok()?;
                    // `comm` may be just the executable name; join remaining parts
                    let name = parts[3..].join(" ");
                    Some(json!({ "pid": pid, "cpu_percent": cpu, "mem_percent": mem, "name": name }))
                })
                .filter(|p| {
                    name_filter.as_ref().map_or(true, |f| {
                        p["name"].as_str().map_or(false, |n| n.to_lowercase().contains(f.as_str()))
                    })
                })
                .collect();

            // Sort
            match sort_by.as_str() {
                "cpu"    => procs.sort_by(|a, b| b["cpu_percent"].as_f64().unwrap_or(0.0).partial_cmp(&a["cpu_percent"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal)),
                "name"   => procs.sort_by(|a, b| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or(""))),
                _        => procs.sort_by(|a, b| b["mem_percent"].as_f64().unwrap_or(0.0).partial_cmp(&a["mem_percent"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal)),
            }
            procs.truncate(limit);

            Ok(json!({ "processes": procs, "count": procs.len() }))
        }
        "kill" => {
            let pid  = params.get("pid").and_then(|v| v.as_i64());
            let name = params.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
            let force = params.get("force").and_then(|v| v.as_bool()).unwrap_or(false);

            if pid.is_none() && name.is_none() {
                return Err(DevToolsError::Input("either pid or name required for mode=kill".into()));
            }

            let signal = if force { "KILL" } else { "TERM" };

            let output = tokio::task::spawn_blocking(move || {
                if let Some(p) = pid {
                    std::process::Command::new("kill")
                        .args(["-s", signal, &p.to_string()])
                        .output()
                } else {
                    std::process::Command::new("pkill")
                        .args(["-s", signal, name.as_deref().unwrap_or("")])
                        .output()
                }
            })
            .await.map_err(|e| DevToolsError::Other(format!("spawn: {e}")))?
            .map_err(|e| DevToolsError::Other(format!("kill: {e}")))?;

            Ok(json!({
                "ok":        output.status.success(),
                "exit_code": output.status.code().unwrap_or(-1),
                "stderr":    String::from_utf8_lossy(&output.stderr).trim_end().to_string(),
            }))
        }
        other => Err(DevToolsError::Input(format!("unknown process mode '{other}'; use list or kill"))),
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// filesystem
// ──────────────────────────────────────────────────────────────────────────────

/// Comprehensive file system operations.
///
/// mode = "read"   — read text file contents (offset, limit in lines)
/// mode = "write"  — write/create/append to a file
/// mode = "list"   — list directory contents
/// mode = "delete" — delete a file or directory (recursive=true for dirs)
/// mode = "copy"   — copy file/dir to destination
/// mode = "move"   — move/rename file/dir to destination
/// mode = "info"   — get file metadata (size, modified, type)
/// mode = "search" — find files matching a glob pattern
pub async fn handle_filesystem(params: Value) -> Result<Value> {
    let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("list").to_string();
    let path_raw = params.get("path").and_then(|v| v.as_str())
        .ok_or_else(|| DevToolsError::Input("path required".into()))?.to_string();

    // Resolve ~ in path
    let path = if path_raw.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{}{}", home, &path_raw[1..])
    } else {
        path_raw
    };

    match mode.as_str() {
        "read" => {
            let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let limit  = params.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);
            let content = tokio::fs::read_to_string(&path).await
                .map_err(|e| DevToolsError::Other(format!("read '{path}': {e}")))?;
            let lines: Vec<&str> = content.lines().collect();
            let total = lines.len();
            let end = limit.map_or(total, |l| (offset + l).min(total));
            let slice = if offset < total { lines[offset..end].join("\n") } else { String::new() };
            Ok(json!({ "content": slice, "total_lines": total, "offset": offset, "lines_returned": end - offset.min(total) }))
        }
        "write" => {
            let content = params.get("content").and_then(|v| v.as_str())
                .ok_or_else(|| DevToolsError::Input("content required for write mode".into()))?.to_string();
            let append = params.get("append").and_then(|v| v.as_bool()).unwrap_or(false);
            // Create parent dirs if needed
            if let Some(parent) = std::path::Path::new(&path).parent() {
                tokio::fs::create_dir_all(parent).await
                    .map_err(|e| DevToolsError::Other(format!("mkdir: {e}")))?;
            }
            if append {
                use tokio::io::AsyncWriteExt;
                let mut f = tokio::fs::OpenOptions::new()
                    .append(true).create(true).open(&path).await
                    .map_err(|e| DevToolsError::Other(format!("open '{path}': {e}")))?;
                f.write_all(content.as_bytes()).await
                    .map_err(|e| DevToolsError::Other(format!("write '{path}': {e}")))?;
            } else {
                tokio::fs::write(&path, content.as_bytes()).await
                    .map_err(|e| DevToolsError::Other(format!("write '{path}': {e}")))?;
            }
            Ok(json!({ "ok": true, "path": path }))
        }
        "list" => {
            let show_hidden = params.get("show_hidden").and_then(|v| v.as_bool()).unwrap_or(false);
            let mut entries_raw = tokio::fs::read_dir(&path).await
                .map_err(|e| DevToolsError::Other(format!("list '{path}': {e}")))?;
            let mut entries = Vec::new();
            while let Ok(Some(entry)) = entries_raw.next_entry().await {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !show_hidden && name.starts_with('.') { continue; }
                if let Ok(meta) = entry.metadata().await {
                    entries.push(json!({
                        "name":     name,
                        "is_dir":   meta.is_dir(),
                        "is_file":  meta.is_file(),
                        "size":     meta.len(),
                    }));
                }
            }
            entries.sort_by(|a, b| {
                let da = a["is_dir"].as_bool().unwrap_or(false);
                let db = b["is_dir"].as_bool().unwrap_or(false);
                db.cmp(&da).then_with(|| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")))
            });
            Ok(json!({ "path": path, "entries": entries, "count": entries.len() }))
        }
        "delete" => {
            let recursive = params.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);
            let meta = tokio::fs::metadata(&path).await
                .map_err(|e| DevToolsError::Other(format!("stat '{path}': {e}")))?;
            if meta.is_dir() {
                if recursive {
                    tokio::fs::remove_dir_all(&path).await
                        .map_err(|e| DevToolsError::Other(format!("rm -r '{path}': {e}")))?;
                } else {
                    tokio::fs::remove_dir(&path).await
                        .map_err(|e| DevToolsError::Other(format!("rmdir '{path}': {e}")))?;
                }
            } else {
                tokio::fs::remove_file(&path).await
                    .map_err(|e| DevToolsError::Other(format!("rm '{path}': {e}")))?;
            }
            Ok(json!({ "ok": true, "deleted": path }))
        }
        "copy" => {
            let dest = params.get("destination").and_then(|v| v.as_str())
                .ok_or_else(|| DevToolsError::Input("destination required for copy mode".into()))?.to_string();
            tokio::task::spawn_blocking(move || {
                std::process::Command::new("cp").args(["-R", &path, &dest]).status()
            })
            .await.map_err(|e| DevToolsError::Other(format!("spawn: {e}")))?
            .map_err(|e| DevToolsError::Other(format!("cp: {e}")))?;
            Ok(json!({ "ok": true }))
        }
        "move" => {
            let dest = params.get("destination").and_then(|v| v.as_str())
                .ok_or_else(|| DevToolsError::Input("destination required for move mode".into()))?.to_string();
            tokio::fs::rename(&path, &dest).await
                .map_err(|e| DevToolsError::Other(format!("rename '{path}'->'{dest}': {e}")))?;
            Ok(json!({ "ok": true }))
        }
        "info" => {
            let meta = tokio::fs::metadata(&path).await
                .map_err(|e| DevToolsError::Other(format!("stat '{path}': {e}")))?;
            use std::time::UNIX_EPOCH;
            let modified = meta.modified().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            let created = meta.created().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            Ok(json!({
                "path":              path,
                "is_file":           meta.is_file(),
                "is_dir":            meta.is_dir(),
                "is_symlink":        meta.file_type().is_symlink(),
                "size_bytes":        meta.len(),
                "modified_unix":     modified,
                "created_unix":      created,
            }))
        }
        "search" => {
            let pattern = params.get("pattern").and_then(|v| v.as_str())
                .ok_or_else(|| DevToolsError::Input("pattern required for search mode".into()))?.to_string();
            let output = tokio::task::spawn_blocking(move || {
                std::process::Command::new("find")
                    .args([&path, "-name", &pattern])
                    .output()
            })
            .await.map_err(|e| DevToolsError::Other(format!("spawn: {e}")))?
            .map_err(|e| DevToolsError::Other(format!("find: {e}")))?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let files: Vec<&str> = stdout.lines().filter(|l| !l.is_empty()).collect();
            Ok(json!({ "matches": files, "count": files.len() }))
        }
        other => Err(DevToolsError::Input(format!("unknown filesystem mode '{other}'; use read/write/list/delete/copy/move/info/search"))),
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_wait_ok() {
        let r = handle_wait(json!({ "duration": 0.01 })).await.unwrap();
        assert_eq!(r["ok"], true);
        assert!((r["waited_seconds"].as_f64().unwrap() - 0.01).abs() < 0.001);
    }

    #[tokio::test]
    async fn test_wait_invalid_duration() {
        assert!(handle_wait(json!({ "duration": 400 })).await.is_err());
    }

    #[tokio::test]
    async fn test_wait_negative_duration() {
        assert!(handle_wait(json!({ "duration": -1 })).await.is_err());
    }

    #[tokio::test]
    async fn test_scrape_rejects_file_scheme() {
        assert!(handle_scrape(json!({ "url": "file:///etc/passwd" })).await.is_err());
    }

    #[tokio::test]
    async fn test_scrape_rejects_missing_url() {
        assert!(handle_scrape(json!({})).await.is_err());
    }

    #[tokio::test]
    async fn test_execute_command_shell() {
        let r = handle_execute_command(json!({ "command": "echo hello" })).await.unwrap();
        assert_eq!(r["exit_code"], 0);
        assert_eq!(r["stdout"].as_str().unwrap().trim(), "hello");
    }

    #[tokio::test]
    async fn test_execute_command_osascript() {
        let r = handle_execute_command(json!({
            "command": "return 42",
            "mode": "osascript"
        })).await.unwrap();
        assert_eq!(r["exit_code"], 0);
        assert!(r["stdout"].as_str().unwrap().contains("42"));
    }

    #[tokio::test]
    async fn test_execute_command_timeout() {
        let r = handle_execute_command(json!({ "command": "sleep 5", "timeout": 1 })).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn test_clipboard_set_get() {
        let unique = format!("tday-test-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        // Set
        let set_r = handle_clipboard(json!({ "mode": "set", "text": unique })).await.unwrap();
        assert_eq!(set_r["ok"], true);
        // Get
        let get_r = handle_clipboard(json!({ "mode": "get" })).await.unwrap();
        assert_eq!(get_r["text"].as_str().unwrap().trim(), unique.as_str());
    }

    #[tokio::test]
    async fn test_process_list() {
        let r = handle_process(json!({ "mode": "list", "limit": 5 })).await.unwrap();
        let procs = r["processes"].as_array().unwrap();
        assert!(!procs.is_empty());
        assert!(procs[0]["pid"].is_i64() || procs[0]["pid"].is_u64());
    }

    #[tokio::test]
    async fn test_process_list_with_filter() {
        let r = handle_process(json!({ "mode": "list", "name": "zsh" })).await.unwrap();
        // May or may not find zsh, but should return a valid list
        assert!(r["processes"].is_array());
    }

    #[tokio::test]
    async fn test_process_kill_requires_pid_or_name() {
        assert!(handle_process(json!({ "mode": "kill" })).await.is_err());
    }

    #[tokio::test]
    async fn test_filesystem_write_read_delete() {
        let path = format!("/tmp/tday-fs-test-{}.txt",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        // Write
        let wr = handle_filesystem(json!({ "mode": "write", "path": path, "content": "line1\nline2\n" })).await.unwrap();
        assert_eq!(wr["ok"], true);
        // Read
        let rd = handle_filesystem(json!({ "mode": "read", "path": path })).await.unwrap();
        assert!(rd["content"].as_str().unwrap().contains("line1"));
        // Info
        let info = handle_filesystem(json!({ "mode": "info", "path": path })).await.unwrap();
        assert_eq!(info["is_file"], true);
        // Delete
        let del = handle_filesystem(json!({ "mode": "delete", "path": path })).await.unwrap();
        assert_eq!(del["ok"], true);
    }

    #[tokio::test]
    async fn test_filesystem_list() {
        let r = handle_filesystem(json!({ "mode": "list", "path": "/tmp" })).await.unwrap();
        assert!(r["entries"].is_array());
    }
}
