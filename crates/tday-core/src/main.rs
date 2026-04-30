// Tday core — v0.1.0 stub.
//
// Real responsibilities land in later versions:
// - v0.4.0 detect: scan localhost for Ollama/LM Studio/llama.cpp/vLLM
// - v0.5.0 tokens: count tokens for usage analytics
// - v0.6.0 memory: SQLite + sqlite-vec long-term memory store
//
// For v0.1.0 this binary just prints its version so the desktop app can
// confirm the sidecar is wired in, without blocking on a Rust toolchain.

use std::env;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--version") | Some("-v") | None => {
            println!("tday-core {}", env!("CARGO_PKG_VERSION"));
        }
        Some("detect") => {
            // Placeholder: emit a JSON envelope the Electron main can parse later.
            println!("{{\"version\":1,\"providers\":[]}}");
        }
        Some(other) => {
            eprintln!("unknown command: {other}");
            std::process::exit(2);
        }
    }
}
