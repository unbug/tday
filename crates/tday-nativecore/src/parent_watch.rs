// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

//! Exit when our parent process dies.
//!
//! Each agent CLI (claude-code, codex, gemini …) spawns `tday-nativecore` as
//! a stdio MCP subprocess.  In practice some agents don't reliably close the
//! stdin pipe when they exit, leaving nativecore orphaned.
//!
//! This module watches the parent process and sends SIGTERM to ourselves when
//! the parent exits, ensuring nativecore never outlives its spawner.
//! It complements the PID-lock singleton in `singleton.rs`:
//!   • parent_watch  → primary cleanup (normal exit, concurrent agents safe)
//!   • singleton     → secondary fallback (kills truly orphaned zombie on next start)
//!
//! Platform implementations:
//!   Linux  : prctl PR_SET_PDEATHSIG — kernel delivers SIGTERM when parent exits
//!   macOS  : kqueue EVFILT_PROC / NOTE_EXIT on parent PID (background thread)
//!   Windows: WaitForSingleObject on parent handle (background thread)

/// Install the parent-death watch.  Returns immediately; the actual watching
/// happens in the background (kernel signal or a background thread).
pub fn start_watching() {
    let ppid = parent_pid();
    tracing::debug!("[parent_watch] watching parent PID {ppid}");

    #[cfg(target_os = "linux")]
    linux_pdeathsig();

    #[cfg(any(target_os = "macos", target_os = "freebsd"))]
    macos_kqueue(ppid);

    #[cfg(target_os = "windows")]
    windows_wait(ppid);
}

// ──────────────────────────────────────────────────────────────────────────────
// Get current parent PID
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(unix)]
fn parent_pid() -> u32 {
    unsafe { libc::getppid() as u32 }
}

#[cfg(target_os = "windows")]
fn parent_pid() -> u32 {
    windows_parent_pid().unwrap_or(0)
}

// ──────────────────────────────────────────────────────────────────────────────
// Linux: prctl PR_SET_PDEATHSIG
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn linux_pdeathsig() {
    // Ask the kernel to send SIGTERM to this process when the parent exits.
    // This is inheritable and requires no polling.
    let ret = unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) };
    if ret == -1 {
        let err = unsafe { *libc::__errno_location() };
        tracing::warn!("[parent_watch] prctl PR_SET_PDEATHSIG failed: errno={err}");
    } else {
        tracing::debug!("[parent_watch] PR_SET_PDEATHSIG installed (Linux)");
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// macOS / FreeBSD: kqueue EVFILT_PROC + NOTE_EXIT
// ──────────────────────────────────────────────────────────────────────────────

/// Polling fallback for when kqueue EVFILT_PROC is unavailable (e.g. sandboxed
/// app bundles on macOS 13+). Polls every 2 s; when the parent disappears,
/// sends SIGTERM to ourselves.
#[cfg(any(target_os = "macos", target_os = "freebsd"))]
fn macos_poll_parent(ppid: u32) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(2));
        let alive = unsafe { libc::kill(ppid as libc::pid_t, 0) == 0 };
        if !alive {
            tracing::info!("[parent_watch] parent PID {ppid} gone (poll) — sending SIGTERM");
            unsafe { libc::kill(libc::getpid(), libc::SIGTERM); }
            return;
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "freebsd"))]
fn macos_kqueue(ppid: u32) {
    if ppid <= 1 {
        // Already orphaned (parent is launchd/init).  Nothing to watch.
        tracing::debug!("[parent_watch] PPID={ppid} is init — skipping kqueue watch");
        return;
    }

    let _ = std::thread::Builder::new()
        .name("parent-watch".into())
        .spawn(move || unsafe {
            let kq = libc::kqueue();
            if kq == -1 {
                tracing::warn!("[parent_watch] kqueue() failed");
                return;
            }

            // Register: watch ppid for NOTE_EXIT.
            let ev_in = libc::kevent {
                ident:  ppid as libc::uintptr_t,
                filter: libc::EVFILT_PROC,
                flags:  (libc::EV_ADD | libc::EV_ONESHOT) as libc::c_ushort,
                fflags: libc::NOTE_EXIT,
                data:   0,
                udata:  std::ptr::null_mut(),
            };

            let ret = libc::kevent(
                kq,
                &ev_in as *const libc::kevent,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            );
            if ret == -1 {
                // kevent registration failed.  This can happen if the parent
                // has already exited OR if the kqueue API is restricted (e.g.
                // in a sandboxed app bundle on macOS 13+).
                // Do NOT self-terminate here — fall back to polling instead.
                libc::close(kq);
                let errno = *libc::__error();
                if errno == libc::ESRCH {
                    // Parent already gone → terminate ourselves.
                    tracing::info!("[parent_watch] parent PID {ppid} already exited (ESRCH) — sending SIGTERM");
                    libc::kill(libc::getpid(), libc::SIGTERM);
                } else {
                    // Other error (e.g. EPERM in restricted sandbox) — fall back to
                    // polling so nativecore doesn't kill itself unnecessarily.
                    tracing::warn!("[parent_watch] kevent register failed (errno={errno}), falling back to polling");
                    macos_poll_parent(ppid);
                }
                return;
            }

            // Block indefinitely until the parent exits.
            let mut ev_out: libc::kevent = std::mem::zeroed();
            let n = libc::kevent(
                kq,
                std::ptr::null(),
                0,
                &mut ev_out as *mut libc::kevent,
                1,
                std::ptr::null(),
            );
            libc::close(kq);

            if n > 0 {
                tracing::info!("[parent_watch] parent PID {ppid} exited — sending SIGTERM to self");
                libc::kill(libc::getpid(), libc::SIGTERM);
            }
        });
}

// ──────────────────────────────────────────────────────────────────────────────
// Windows: background thread that waits on the parent process handle
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn windows_wait(ppid: u32) {
    if ppid == 0 {
        tracing::warn!("[parent_watch] could not determine parent PID on Windows");
        return;
    }

    let _ = std::thread::Builder::new()
        .name("parent-watch".into())
        .spawn(move || {
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Threading::{
                OpenProcess, TerminateProcess, WaitForSingleObject,
                PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, INFINITE,
            };
            use windows::Win32::System::Threading::GetCurrentProcess;

            unsafe {
                let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, ppid) else {
                    tracing::warn!("[parent_watch] OpenProcess({ppid}) failed — parent may be gone");
                    return;
                };

                // Wait until the parent process exits.
                WaitForSingleObject(h, INFINITE);
                let _ = CloseHandle(h);

                tracing::info!("[parent_watch] parent PID {ppid} exited — terminating self");

                // Terminate ourselves cleanly.
                let Ok(self_h) = OpenProcess(PROCESS_TERMINATE, false,
                    windows::Win32::System::Threading::GetCurrentProcessId()) else { return; };
                let _ = TerminateProcess(self_h, 0);
                let _ = CloseHandle(self_h);
            }
        });
}

#[cfg(target_os = "windows")]
fn windows_parent_pid() -> Option<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::GetCurrentProcessId;

    let my_pid = unsafe { GetCurrentProcessId() };

    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return None;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..std::mem::zeroed()
        };

        if Process32First(snap, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == my_pid {
                    let ppid = entry.th32ParentProcessID;
                    let _ = CloseHandle(snap);
                    return Some(ppid);
                }
                if Process32Next(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        None
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_pid_is_nonzero() {
        // Our test process always has a valid parent (the test runner).
        assert!(parent_pid() > 1, "parent PID should be > 1 (not init)");
    }

    #[test]
    fn start_watching_does_not_panic() {
        // Calling start_watching from a test runner whose parent is alive
        // should silently install the watch without panicking.
        start_watching();
    }
}
