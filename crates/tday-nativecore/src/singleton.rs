// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

//! Single-instance guard for tday-nativecore.
//!
//! Works in tandem with `parent_watch`:
//!   • parent_watch  → PRIMARY: nativecore exits when its parent (agent) exits.
//!                     Enables multiple concurrent agents, zero zombies normally.
//!   • singleton     → FALLBACK: on next startup, kill any truly ORPHANED process
//!                     (parent already gone, parent_watch somehow failed to fire).
//!
//! Key rule: ONLY kill a previous instance if it is **orphaned** (its parent
//! PID is 1 / launchd / systemd).  If it still has a live parent we leave it
//! alone — it belongs to a concurrent agent session.
//!
//! Lock file location: `<tmp>/tday-nativecore.lock`
//!   macOS/Linux : /tmp/tday-nativecore.lock
//!   Windows     : %TEMP%\tday-nativecore.lock

use std::fs;
use std::path::PathBuf;

// ──────────────────────────────────────────────────────────────────────────────
// File-level lock (POSIX flock / Windows LockFileEx)
//
// We hold the OS-level advisory lock for the entire duration of the
// read-kill-write critical section so that two concurrently-starting
// nativecore processes cannot both believe they have acquired the singleton.
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(unix)]
fn with_file_lock<F: FnOnce()>(path: &std::path::Path, f: F) {
    use std::os::unix::io::AsRawFd;
    // Open (or create) the lock file.
    let file = match fs::OpenOptions::new().create(true).write(true).open(path) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("[singleton] could not open lock file for flock: {e}");
            f();
            return;
        }
    };
    // Acquire exclusive advisory lock — blocks if another instance holds it.
    let ret = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if ret == -1 {
        tracing::warn!("[singleton] flock(LOCK_EX) failed; proceeding without lock");
    }
    f();
    // Lock is released automatically when `file` is dropped (fd closed).
}

#[cfg(not(unix))]
fn with_file_lock<F: FnOnce()>(_path: &std::path::Path, f: F) {
    // Windows: advisory flock is not available; rely on the existing PID check.
    f();
}

// ──────────────────────────────────────────────────────────────────────────────

fn lock_path() -> PathBuf {
    std::env::temp_dir().join("tday-nativecore.lock")
}

/// Read the PID stored in the lock file; `None` if absent / unreadable.
fn read_lock_pid() -> Option<u32> {
    fs::read_to_string(lock_path()).ok()?.trim().parse().ok()
}

/// Write our PID to the lock file (creates / overwrites).
fn write_lock_pid(pid: u32) {
    let path = lock_path();
    if let Err(e) = fs::write(&path, pid.to_string()) {
        tracing::warn!("[singleton] could not write lock file {}: {e}", path.display());
    }
}

/// Remove the lock file.  Called in `SingletonGuard::drop`.
fn remove_lock() {
    let path = lock_path();
    // Only remove if it still contains our PID — avoids clobbering a
    // lock written by a newer instance that has already taken over.
    if read_lock_pid() == Some(std::process::id()) {
        let _ = fs::remove_file(&path);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Platform-specific "is PID alive?" + "kill PID"
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    // kill(pid, 0) returns ESRCH when the process does not exist.
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    ret == 0
}

#[cfg(unix)]
fn terminate_pid(pid: u32) {
    unsafe {
        // Polite first.
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
    // Wait up to 2 s for graceful exit.
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if !pid_is_alive(pid) { return; }
    }
    // Force-kill if still running.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL); }
    tracing::warn!("[singleton] sent SIGKILL to stale PID {pid}");
}

#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // STILL_ACTIVE == 259 (STATUS_PENDING / WAIT_TIMEOUT constant for GetExitCodeProcess)
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code: u32 = 0;
        let alive = GetExitCodeProcess(h, &mut code).is_ok() && code == STILL_ACTIVE;
        let _ = CloseHandle(h);
        alive
    }
}

#[cfg(windows)]
fn terminate_pid(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_TERMINATE,
    };
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) else { return; };
        let _ = TerminateProcess(h, 1);
        let _ = CloseHandle(h);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Platform-specific orphan check
// ──────────────────────────────────────────────────────────────────────────────

/// Returns `true` if `pid` is a zombie/orphan (its parent is init/launchd/systemd,
/// i.e. PPID ≤ 1).  Conservative: if the parent PID cannot be determined,
/// returns `false` so we don't kill active sessions.
#[cfg(target_os = "linux")]
fn pid_is_orphan(pid: u32) -> bool {
    let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) else {
        return false; // Can't read → assume it has a live parent
    };
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("PPid:") {
            let ppid: i64 = rest.trim().parse().unwrap_or(-1);
            return ppid <= 1;
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn pid_is_orphan(pid: u32) -> bool {
    // Use proc_pidinfo(PROC_PIDTBSDINFO) to read pbi_ppid.
    // proc_bsdinfo layout (from <sys/proc_info.h>):
    //   uint32 pbi_flags   [0]
    //   uint32 pbi_status  [4]
    //   uint32 pbi_xstatus [8]
    //   uint32 pbi_pid     [12]
    //   uint32 pbi_ppid    [16]  <── we only need up to here
    extern "C" {
        fn proc_pidinfo(
            pid: libc::c_int,
            flavor: libc::c_int,
            arg: u64,
            buffer: *mut u8,
            buffersize: libc::c_int,
        ) -> libc::c_int;
    }
    const PROC_PIDTBSDINFO: libc::c_int = 3;
    const MIN_BYTES: usize = 20; // need at least bytes 0..20 for pbi_ppid

    let mut buf = [0u8; MIN_BYTES];
    let ret = unsafe {
        proc_pidinfo(
            pid as libc::c_int,
            PROC_PIDTBSDINFO,
            0,
            buf.as_mut_ptr(),
            MIN_BYTES as libc::c_int,
        )
    };
    if ret < MIN_BYTES as libc::c_int {
        return false; // Can't determine → don't kill
    }
    let ppid = u32::from_ne_bytes([buf[16], buf[17], buf[18], buf[19]]);
    ppid <= 1
}

// FreeBSD: sysctl approach same as macOS
#[cfg(target_os = "freebsd")]
fn pid_is_orphan(_pid: u32) -> bool { false }

// Windows: no reliable "orphan" concept; be conservative, never kill active.
#[cfg(target_os = "windows")]
fn pid_is_orphan(_pid: u32) -> bool { false }

// ──────────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────────

/// Holds the singleton lock for this process.
/// Deletes the lock file on drop.
pub struct SingletonGuard {
    // The field is intentionally empty; Drop does all the work.
    _private: (),
}

impl Drop for SingletonGuard {
    fn drop(&mut self) {
        remove_lock();
        tracing::debug!("[singleton] lock released");
    }
}

/// Acquire the single-instance lock.
///
/// Only terminates the previous instance if it is **orphaned** (PPID ≤ 1).
/// A process with a live parent belongs to a concurrent agent session and is
/// left untouched, enabling multiple agents to run simultaneously.
///
/// Uses an OS-level advisory file lock (flock on Unix) to make the
/// read-check-kill-write sequence atomic and eliminate the TOCTOU race
/// that would otherwise allow two processes to simultaneously believe
/// they have acquired the lock.
///
/// Returns a `SingletonGuard` that removes the lock file when dropped.
pub fn acquire() -> SingletonGuard {
    let my_pid = std::process::id();
    let path = lock_path();

    with_file_lock(&path, || {
        if let Some(old_pid) = read_lock_pid() {
            if old_pid != my_pid && pid_is_alive(old_pid) {
                if pid_is_orphan(old_pid) {
                    tracing::info!(
                        "[singleton] orphaned tday-nativecore PID {old_pid} found — terminating"
                    );
                    terminate_pid(old_pid);
                    if pid_is_alive(old_pid) {
                        tracing::warn!("[singleton] PID {old_pid} still alive after kill attempt");
                    } else {
                        tracing::info!("[singleton] orphan PID {old_pid} terminated");
                    }
                } else {
                    tracing::info!(
                        "[singleton] PID {old_pid} is alive with active parent — leaving it \
                         (concurrent agent session)"
                    );
                }
            }
        }

        write_lock_pid(my_pid);
    });

    tracing::info!("[singleton] lock acquired (PID {my_pid})");
    SingletonGuard { _private: () }
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests (pure logic, no process spawning)
// ──────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Serialize all tests that touch the shared lock file so they don't race
    // when the test harness runs them in parallel threads.
    static FILE_MTX: Mutex<()> = Mutex::new(());

    #[test]
    fn lock_path_is_in_temp_dir() {
        let p = lock_path();
        assert!(p.starts_with(std::env::temp_dir()));
        assert_eq!(p.file_name().unwrap(), "tday-nativecore.lock");
    }

    #[test]
    fn write_and_read_lock_pid_round_trip() {
        let _g = FILE_MTX.lock().unwrap();
        let pid = std::process::id();
        write_lock_pid(pid);
        assert_eq!(read_lock_pid(), Some(pid));
        // Cleanup
        remove_lock();
        assert_eq!(read_lock_pid(), None);
    }

    #[test]
    fn remove_lock_only_removes_own_pid() {
        let _g = FILE_MTX.lock().unwrap();
        // Write a fake PID that is not ours.
        let fake_pid = u32::MAX; // very unlikely to be our PID
        let path = lock_path();
        let _ = fs::write(&path, fake_pid.to_string());
        // remove_lock should NOT remove it (wrong PID in file).
        remove_lock();
        // File should still exist with the fake PID.
        assert_eq!(read_lock_pid(), Some(fake_pid));
        // Actual cleanup for test hygiene.
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn pid_is_alive_current_process() {
        // The current process is obviously alive.
        assert!(pid_is_alive(std::process::id()));
    }

    #[test]
    fn pid_is_alive_returns_false_for_nonexistent_pid() {
        // PID 0 is never a user process; use a high implausible PID instead.
        assert!(!pid_is_alive(4_000_000));
    }
}
