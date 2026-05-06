/// AX element session — retains handles from `take_ax_snapshot` so subsequent
/// `ax_click` / `ax_set_value` calls can dispatch against live elements by uid.
///
/// UIDs are strings of the form `"a<N>g<gen>"`.  The generation is bumped on
/// every new snapshot, so stale uids are rejected by construction.

#[cfg(target_os = "macos")]
use crate::platform::AXRef;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::RwLock;

// ──────────────────────────────────────────────────────────────────────────────
// UID parsing
// ──────────────────────────────────────────────────────────────────────────────

/// Parse `"a<u32>g<u64>"` → `(n, generation)`.
pub fn parse_uid(s: &str) -> Option<(u32, u64)> {
    let rest = s.strip_prefix('a')?;
    let g = rest.find('g')?;
    let (n_str, gen_str) = rest.split_at(g);
    let gen_str = &gen_str[1..];
    if n_str.is_empty() || gen_str.is_empty() { return None; }
    Some((n_str.parse().ok()?, gen_str.parse().ok()?))
}

// ──────────────────────────────────────────────────────────────────────────────
// Session
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LookupError {
    SnapshotExpired { reason: String },
    UidNotFound,
}

impl std::fmt::Display for LookupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LookupError::SnapshotExpired { reason } => write!(f, "Snapshot expired: {reason}"),
            LookupError::UidNotFound => write!(f, "UID not found in current snapshot"),
        }
    }
}

#[cfg(target_os = "macos")]
struct Snapshot {
    generation: u64,
    refs: HashMap<u32, AXRef>,
}

#[cfg(target_os = "macos")]
pub struct AxSession {
    current: RwLock<Option<Snapshot>>,
    next_gen: AtomicU64,
}

#[cfg(target_os = "macos")]
impl Default for AxSession {
    fn default() -> Self { Self::new() }
}

#[cfg(target_os = "macos")]
impl AxSession {
    pub fn new() -> Self {
        Self { current: RwLock::new(None), next_gen: AtomicU64::new(1) }
    }

    /// Install a fresh snapshot; returns the assigned generation.
    /// The generation is assigned *inside* the write lock to prevent interleaving.
    pub async fn create_snapshot(&self, refs: HashMap<u32, AXRef>) -> u64 {
        let mut guard = self.current.write().await;
        let gen = self.next_gen.fetch_add(1, Ordering::SeqCst);
        *guard = Some(Snapshot { generation: gen, refs });
        gen
    }

    /// Dispatch: resolve `uid`, hold read lock across `f`, preventing a
    /// concurrent `create_snapshot` from invalidating mid-dispatch.
    pub async fn dispatch<F, R>(&self, uid: &str, f: F) -> Result<R, LookupError>
    where
        F: FnOnce(&AXRef) -> R,
    {
        let (n, gen) = parse_uid(uid).ok_or_else(|| LookupError::SnapshotExpired {
            reason: format!("uid must match a<N>g<gen>; got: {uid}"),
        })?;
        let guard = self.current.read().await;
        let snap = guard.as_ref().ok_or_else(|| LookupError::SnapshotExpired {
            reason: "no take_ax_snapshot has been called".into(),
        })?;
        if snap.generation != gen {
            return Err(LookupError::SnapshotExpired {
                reason: format!("uid generation g{gen} does not match current g{}", snap.generation),
            });
        }
        let ax = snap.refs.get(&n).ok_or(LookupError::UidNotFound)?;
        Ok(f(ax))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_uid_valid()    { assert_eq!(parse_uid("a42g3"), Some((42, 3))); }
    #[test]
    fn parse_uid_bare_n()   { assert_eq!(parse_uid("a42"),   None); }
    #[test]
    fn parse_uid_empty_gen(){ assert_eq!(parse_uid("a42g"),  None); }
    #[test]
    fn parse_uid_no_prefix(){ assert_eq!(parse_uid("42g3"),  None); }
}
