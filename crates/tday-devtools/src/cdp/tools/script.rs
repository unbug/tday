//! CDP script/snapshot tools: evaluate_script, take_dom_snapshot, find_elements,
//! get_element_context, summarize_page, wait_for, wait_for_page_change.

use crate::cdp::{cdp_error, page_url, CdpClient};
use chromiumoxide::cdp::browser_protocol::dom::{BackendNodeId, DescribeNodeParams, ResolveNodeParams};
use chromiumoxide::cdp::js_protocol::runtime::{
    CallArgument, CallFunctionOnParams, EvaluateParams, ReleaseObjectParams,
};
use chromiumoxide::page::Page;
use rmcp::model::{CallToolResult, Content};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::RwLock;

// ─── constants ───────────────────────────────────────────────────────────────

const MAX_WAIT_TIMEOUT_MS: u64              = 60_000;
const MAX_PAGE_CHANGE_WAIT_TIMEOUT_MS: u64  = 55_000;
const DEFAULT_PAGE_CHANGE_WAIT_TIMEOUT_MS: u64 = 55_000;
const DEFAULT_PAGE_CHANGE_POLL_MS: u64      = 500;
const MIN_PAGE_CHANGE_POLL_MS: u64          = 100;
const MAX_PAGE_CHANGE_POLL_MS: u64          = 5_000;
const DEFAULT_PAGE_CHANGE_STABLE_MS: u64    = 500;
const MIN_PAGE_CHANGE_STABLE_MS: u64        = 100;
const MAX_PAGE_CHANGE_STABLE_MS: u64        = 2_000;

// ─── evaluate_script ─────────────────────────────────────────────────────────

fn format_js_result(result: &chromiumoxide::cdp::js_protocol::runtime::EvaluateReturns) -> CallToolResult {
    if let Some(exc) = &result.exception_details {
        return cdp_error(format!("JavaScript exception: {}", exc.text));
    }
    let value = result.result.value.as_ref().cloned().unwrap_or(Value::Null);
    CallToolResult::success(vec![Content::text(
        serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".to_string()),
    )])
}

pub async fn cdp_evaluate_script(
    function: String,
    args: Option<Vec<Value>>,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection. Use cdp_connect first.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };

    let has_uid_args = args.as_ref().is_some_and(|a| a.iter().any(|v| v.get("uid").is_some()));
    if !has_uid_args {
        let trimmed = function.trim_start();
        let is_fn = trimmed.starts_with("function") || trimmed.starts_with("async function") || function.contains("=>");
        let expression = if is_fn { format!("({})()", function) } else { function };
        let mut ep = EvaluateParams::new(expression);
        ep.return_by_value = Some(true);
        ep.await_promise   = Some(true);
        return match page.execute(ep).await {
            Ok(resp) => format_js_result(&resp.result),
            Err(e)   => cdp_error(format!("Failed to evaluate script: {e}")),
        };
    }

    let arg_list = match args.as_ref() {
        Some(a) => a,
        None    => return cdp_error("args required when passing element references"),
    };

    let current_url = page_url(&page).await;
    let mut uid_backend_pairs: Vec<(String, i64)> = Vec::new();
    for arg in arg_list {
        if let Some(uid) = arg.get("uid").and_then(|v| v.as_str()) {
            let node = match crate::cdp::resolve_uid(uid, client.last_dom_snapshot.as_ref(), client.generation, &current_url) {
                Ok(n)    => n,
                Err(msg) => return cdp_error(msg),
            };
            uid_backend_pairs.push((uid.to_string(), node.backend_node_id));
        }
    }

    let mut call_arguments: Vec<CallArgument> = Vec::new();
    let mut first_object_id = None;
    for (uid, backend_node_id) in &uid_backend_pairs {
        let resolve_params = ResolveNodeParams::builder().backend_node_id(BackendNodeId::new(*backend_node_id)).build();
        let remote_object = match page.execute(resolve_params).await {
            Ok(resp) => resp.result.object,
            Err(_)   => return cdp_error(format!("Element uid={uid} could not be resolved to a DOM node.")),
        };
        let object_id = match remote_object.object_id {
            Some(id) => id,
            None     => return cdp_error(format!("Element uid={uid} could not be resolved to a DOM node.")),
        };
        if first_object_id.is_none() { first_object_id = Some(object_id.clone()); }
        call_arguments.push(CallArgument::builder().object_id(object_id).build());
    }

    let target_object_id = match first_object_id {
        Some(id) => id,
        None     => return cdp_error("No element arguments could be resolved."),
    };
    let call_params = match CallFunctionOnParams::builder()
        .function_declaration(function)
        .object_id(target_object_id)
        .arguments(call_arguments)
        .return_by_value(true)
        .await_promise(true)
        .build()
    {
        Ok(p) => p,
        Err(e) => return cdp_error(format!("Failed to build call params: {e}")),
    };
    match page.execute(call_params).await {
        Ok(resp) => {
            if let Some(exc) = &resp.result.exception_details { return cdp_error(format!("JavaScript exception: {}", exc.text)); }
            let value = resp.result.result.value.as_ref().cloned().unwrap_or(Value::Null);
            CallToolResult::success(vec![Content::text(serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".to_string()))])
        }
        Err(e) => cdp_error(format!("Failed to call function: {e}")),
    }
}

// ─── wait_for ────────────────────────────────────────────────────────────────

pub async fn cdp_wait_for(
    texts: Vec<String>,
    timeout_ms: Option<u64>,
    include_snapshot: bool,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let raw_timeout  = timeout_ms.unwrap_or(10_000).min(MAX_WAIT_TIMEOUT_MS);
    let timeout      = std::time::Duration::from_millis(raw_timeout);
    let poll_interval = std::time::Duration::from_millis(500);
    let start        = std::time::Instant::now();

    let texts_json = serde_json::to_string(&texts).unwrap();
    let check_js   = format!("document.body && {texts_json}.some(t => document.body.innerText.includes(t))");

    loop {
        let found = {
            let guard  = cdp_client.read().await;
            let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection.") };
            let page   = match client.require_page() { Ok(p) => p, Err(e) => return e };
            let mut ep = EvaluateParams::new(&check_js);
            ep.return_by_value = Some(true);
            match page.execute(ep).await {
                Ok(resp) => resp.result.result.value.as_ref().and_then(|v| v.as_bool()).unwrap_or(false),
                Err(_)   => false,
            }
        };
        if found {
            let elapsed_ms = start.elapsed().as_millis();
            let header = format!("Text appeared after {elapsed_ms}ms: {texts_json}");
            if !include_snapshot { return CallToolResult::success(vec![Content::text(header)]); }
            let mut result = cdp_take_dom_snapshot(Some(100), cdp_client.clone()).await;
            result.content.insert(0, Content::text(header));
            return result;
        }
        if start.elapsed() >= timeout {
            return cdp_error(format!("Timed out after {}ms waiting for: {texts_json}", timeout.as_millis()));
        }
        tokio::time::sleep(poll_interval).await;
    }
}

// ─── wait_for_page_change ────────────────────────────────────────────────────

const PAGE_CHANGE_WAIT_JS: &str = r#"
async function(timeoutMs, stableMs, pollIntervalMs) {
  const root = (this && this.nodeType === Node.ELEMENT_NODE) ? this : document.body;
  const startedAt = Date.now();
  const safeRoot = root || document.body;
  const normalizeLines = v => String(v||'').replace(/\u200e|\u200f|\u202a|\u202b|\u202c|\u202d|\u202e|\u2066|\u2067|\u2068|\u2069/g,'').split(/\n+/).map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n').trim();
  const stripDynamic = v => normalizeLines(v).replace(/\b(?:now|today|yesterday)\b/gi,'<relative-time>').replace(/\b\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|mo|month|months|y|yr|yrs|year|years)\b/gi,'<relative-time>');
  const hash = v => { let h=2166136261; for(let i=0;i<v.length;i++){h^=v.charCodeAt(i);h=Math.imul(h,16777619);} return `${(h>>>0).toString(16).padStart(8,'0')}:${v.length}`; };
  const roleFor = el => { if(!el||!el.getAttribute) return ''; const r=el.getAttribute('role'); if(r) return r; const t=(el.tagName||'').toLowerCase(); if(t==='button') return 'button'; if(t==='a'&&el.hasAttribute('href')) return 'link'; if(t==='input'||t==='textarea'||el.isContentEditable) return 'textbox'; if(t==='select') return 'combobox'; return t; };
  const isVisible = el => { if(!(el instanceof Element)) return false; if(el===document.body||el===safeRoot) return true; const s=window.getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden') return false; const r=el.getBoundingClientRect(); return r.width>0||r.height>0; };
  const fieldSelector='input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]';
  const fieldValue = el => { if(!el) return ''; if('value' in el&&el.value!=null&&String(el.value).trim()) return el.value; return el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('placeholder')||''; };
  const summarizeElement = el => { if(!el) return null; return {tag:(el.tagName||'').toLowerCase(),role:roleFor(el),aria_label:normalizeLines(el.getAttribute?el.getAttribute('aria-label'):'').slice(0,240),placeholder:normalizeLines(el.getAttribute?(el.getAttribute('placeholder')||el.getAttribute('data-placeholder')):'').slice(0,240),text:normalizeLines(('value' in el&&el.value)?el.value:(el.innerText||el.textContent||'')).slice(-500)}; };
  const capture = () => {
    const textSource=safeRoot&&'innerText' in safeRoot?safeRoot.innerText:(safeRoot?safeRoot.textContent:'');
    const visibleText=normalizeLines(textSource);
    const fields=[]; if(safeRoot&&safeRoot.matches&&safeRoot.matches(fieldSelector)) fields.push(safeRoot); if(safeRoot&&safeRoot.querySelectorAll) fields.push(...safeRoot.querySelectorAll(fieldSelector));
    const fieldText=fields.filter((el,i)=>fields.indexOf(el)===i).filter(isVisible).map(fieldValue).map(normalizeLines).filter(Boolean).join('\n');
    const semanticText=stripDynamic([visibleText,fieldText].filter(Boolean).join('\n'));
    const semanticUnits=semanticText.split(/\n+/).map(v=>v.trim()).filter(Boolean);
    return {signature:hash(`${location.href}\n${document.title||''}\n${semanticText}`),url:location.href,title:document.title||'',text_length:visibleText.length,semantic_text_length:semanticText.length,visible_text_tail:visibleText.slice(-2500),semantic_text_tail:semanticText.slice(-2500),semantic_units:semanticUnits.slice(-50),root:summarizeElement(safeRoot),active_element:summarizeElement(document.activeElement)};
  };
  const addedUnits = (b,a) => { const c=new Map(); for(const u of b||[]) c.set(u,(c.get(u)||0)+1); const r=[]; for(const u of a||[]){const n=c.get(u)||0;if(n>0){c.set(u,n-1);}else{r.push(u);}} return r.slice(-20); };
  const suffixDelta = (b,a) => { let i=0,lim=Math.min(b.length,a.length); while(i<lim&&b.charCodeAt(i)===a.charCodeAt(i))i++; return a.slice(i).trim().slice(-2500); };
  const buildResult = (changed,timedOut,before,after,trigger) => ({source:'dom_semantic_wait',page_url:after.url,title:after.title,changed,timed_out:timedOut,elapsed_ms:Date.now()-startedAt,timeout_ms:timeoutMs,stable_ms:stableMs,poll_interval_ms:pollIntervalMs,trigger,before:{signature:before.signature,text_length:before.text_length,semantic_text_length:before.semantic_text_length,visible_text_tail:before.visible_text_tail,semantic_text_tail:before.semantic_text_tail,root:before.root,active_element:before.active_element},after:{signature:after.signature,text_length:after.text_length,semantic_text_length:after.semantic_text_length,visible_text_tail:after.visible_text_tail,semantic_text_tail:after.semantic_text_tail,root:after.root,active_element:after.active_element},deltas:changed?[{kind:'semantic_text_delta',text:suffixDelta(before.semantic_text_tail,after.semantic_text_tail),added_text:addedUnits(before.semantic_units,after.semantic_units)}]:[]});
  const meaningfulMutation = m => { if(m.type==='childList'||m.type==='characterData') return true; if(m.type!=='attributes') return false; return ['value','aria-label','aria-selected','aria-checked','aria-expanded','aria-pressed','role','placeholder','title','disabled'].includes(m.attributeName); };
  const waitForWake = remainingMs => new Promise(resolve=>{let settled=false,stableTimer=null,observer=null; const cleanup=()=>{if(stableTimer)clearTimeout(stableTimer);clearTimeout(timeoutTimer);clearInterval(pollTimer);if(observer)observer.disconnect();}; const finish=reason=>{if(settled)return;settled=true;cleanup();resolve(reason);}; const schedule=reason=>{if(stableTimer)clearTimeout(stableTimer);stableTimer=setTimeout(()=>finish(reason),stableMs);}; try{observer=new MutationObserver(ms=>{if(ms.some(meaningfulMutation))schedule('mutation');});observer.observe(safeRoot,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['value','aria-label','aria-selected','aria-checked','aria-expanded','aria-pressed','role','placeholder','title','disabled']});}catch(_){schedule('observer_unavailable');} const pollTimer=setInterval(()=>schedule('poll'),pollIntervalMs); const timeoutTimer=setTimeout(()=>finish('timeout'),Math.max(0,remainingMs));});
  const before=capture(); let latest=before;
  while(Date.now()-startedAt<timeoutMs){const remainingMs=timeoutMs-(Date.now()-startedAt);const trigger=await waitForWake(remainingMs);latest=capture();if(latest.signature!==before.signature){return buildResult(true,false,before,latest,trigger);}if(trigger==='timeout')break;}
  return buildResult(false,true,before,latest,'timeout');
}
"#;

fn string_argument(value: impl Into<Value>) -> CallArgument {
    CallArgument::builder().value(value.into()).build()
}

async fn resolve_scope_backend_node_id(
    scope_uid: &str,
    page: &Page,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> Result<i64, CallToolResult> {
    let current_url = page_url(page).await;
    let guard = cdp_client.read().await;
    let client = guard.as_ref().ok_or_else(|| cdp_error("No CDP connection."))?;
    let node = crate::cdp::resolve_uid(scope_uid, client.last_dom_snapshot.as_ref(), client.generation, &current_url).map_err(cdp_error)?;
    Ok(node.backend_node_id)
}

async fn resolve_scope_object_id(
    scope_uid: &str,
    backend_node_id: i64,
    page: &Page,
) -> Result<chromiumoxide::cdp::js_protocol::runtime::RemoteObjectId, CallToolResult> {
    let resolve_params = ResolveNodeParams::builder().backend_node_id(BackendNodeId::new(backend_node_id)).build();
    let remote = page.execute(resolve_params).await.map_err(|e| cdp_error(format!("Scope uid={scope_uid} could not be resolved: {e}")))?;
    remote.result.object.object_id.ok_or_else(|| cdp_error(format!("Scope uid={scope_uid} could not be resolved.")))
}

async fn wait_for_page_semantic_change(page: &Page, timeout_ms: u64, stable_ms: u64, poll_ms: u64) -> Result<Value, CallToolResult> {
    let expression = format!("({PAGE_CHANGE_WAIT_JS}).call(document.body, {timeout_ms}, {stable_ms}, {poll_ms})");
    let mut ep = EvaluateParams::new(expression);
    ep.return_by_value = Some(true);
    ep.await_promise   = Some(true);
    let resp = page.execute(ep).await.map_err(|e| cdp_error(format!("Failed to wait for page change: {e}")))?;
    if let Some(exc) = &resp.result.exception_details { return Err(cdp_error(format!("JS exception: {}", exc.text))); }
    Ok(resp.result.result.value.as_ref().cloned().unwrap_or(Value::Null))
}

async fn wait_for_scoped_semantic_change(
    page: &Page,
    object_id: chromiumoxide::cdp::js_protocol::runtime::RemoteObjectId,
    timeout_ms: u64, stable_ms: u64, poll_ms: u64,
) -> Result<Value, CallToolResult> {
    let call_params = CallFunctionOnParams::builder()
        .function_declaration(PAGE_CHANGE_WAIT_JS)
        .object_id(object_id.clone())
        .arguments(vec![string_argument(timeout_ms), string_argument(stable_ms), string_argument(poll_ms)])
        .return_by_value(true)
        .await_promise(true)
        .build()
        .map_err(|e| cdp_error(format!("Failed to build wait params: {e}")))?;
    let resp = page.execute(call_params).await;
    let _ = page.execute(ReleaseObjectParams::new(object_id)).await;
    let r = resp.map_err(|e| cdp_error(format!("Failed to wait for page change: {e}")))?;
    if let Some(exc) = &r.result.exception_details { return Err(cdp_error(format!("JS exception: {}", exc.text))); }
    Ok(r.result.result.value.as_ref().cloned().unwrap_or(Value::Null))
}

fn decorate_semantic_wait_result(mut value: Value, scope_uid: Option<&str>, condition: &str, goal: Option<&str>) -> Value {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("scope".to_string(), serde_json::json!({"kind": if scope_uid.is_some() { "element" } else { "page" }, "uid": scope_uid}));
        obj.insert("condition".to_string(), Value::String(condition.to_string()));
        if let Some(g) = goal { obj.insert("goal".to_string(), Value::String(g.to_string())); }
        obj.insert("hint".to_string(), Value::String("The wait tool consumed one agent step. Judge whether `deltas` satisfies the goal; if it does, act on it, otherwise call this wait tool again.".to_string()));
    }
    value
}

pub async fn cdp_wait_for_page_change(
    scope_uid:       Option<String>,
    condition:       Option<String>,
    goal:            Option<String>,
    timeout_ms:      Option<u64>,
    poll_interval_ms: Option<u64>,
    stable_ms:       Option<u64>,
    include_snapshot: bool,
    cdp_client:      Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let raw_timeout  = timeout_ms.unwrap_or(DEFAULT_PAGE_CHANGE_WAIT_TIMEOUT_MS).min(MAX_PAGE_CHANGE_WAIT_TIMEOUT_MS);
    let poll_interval = poll_interval_ms.unwrap_or(DEFAULT_PAGE_CHANGE_POLL_MS).clamp(MIN_PAGE_CHANGE_POLL_MS, MAX_PAGE_CHANGE_POLL_MS);
    let stable       = stable_ms.unwrap_or(DEFAULT_PAGE_CHANGE_STABLE_MS).clamp(MIN_PAGE_CHANGE_STABLE_MS, MAX_PAGE_CHANGE_STABLE_MS);
    let condition    = condition.unwrap_or_else(|| "semantic_delta".to_string());
    let scope_uid    = scope_uid.filter(|u| !u.trim().is_empty());

    let page = {
        let guard = cdp_client.read().await;
        let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection.") };
        match client.require_page() { Ok(p) => p, Err(e) => return e }
    };

    let value = match scope_uid.as_deref() {
        Some(uid) => {
            let bnid = match resolve_scope_backend_node_id(uid, &page, cdp_client.clone()).await { Ok(n) => n, Err(e) => return e };
            let oid  = match resolve_scope_object_id(uid, bnid, &page).await { Ok(o) => o, Err(e) => return e };
            match wait_for_scoped_semantic_change(&page, oid, raw_timeout, stable, poll_interval).await { Ok(v) => v, Err(e) => return e }
        }
        None => match wait_for_page_semantic_change(&page, raw_timeout, stable, poll_interval).await { Ok(v) => v, Err(e) => return e },
    };

    let result = decorate_semantic_wait_result(value, scope_uid.as_deref(), &condition, goal.as_deref());
    let result_text = serde_json::to_string_pretty(&result).unwrap_or_default();
    if !include_snapshot { return CallToolResult::success(vec![Content::text(result_text)]); }
    let mut snap = cdp_take_dom_snapshot(Some(100), cdp_client).await;
    snap.content.insert(0, Content::text(result_text));
    snap
}

// ─── DOM candidate resolution helpers ────────────────────────────────────────

async fn resolve_dom_candidates(
    page: &Page,
    walker_js: &str,
) -> Result<(Vec<crate::cdp::dom_discovery::DomCandidate>, Value), CallToolResult> {
    let mut ep = EvaluateParams::new(walker_js);
    ep.return_by_value = Some(false);
    let walker_result = match page.execute(ep).await {
        Ok(r)  => r,
        Err(e) => return Err(cdp_error(format!("DOM walker failed: {e}"))),
    };
    let result_object_id = match walker_result.result.result.object_id {
        Some(id) => id,
        None     => return Err(cdp_error("DOM walker returned no object reference")),
    };

    // Extract inventory JSON.
    let inventory_js = "function() { return JSON.stringify(this.inventory); }";
    let inventory: Value = match page.execute(CallFunctionOnParams::builder().function_declaration(inventory_js).object_id(result_object_id.clone()).return_by_value(true).build().unwrap()).await {
        Ok(resp) => resp.result.result.value.and_then(|v| v.as_str().and_then(|s| serde_json::from_str(s).ok())).unwrap_or(serde_json::json!([])),
        Err(_)   => serde_json::json!([]),
    };

    // Extract metadata JSON (all candidates in one call).
    let meta_js = "function() { return JSON.stringify(this.metadata); }";
    let all_metadata: Vec<crate::cdp::dom_discovery::DomCandidate> =
        match page.execute(CallFunctionOnParams::builder().function_declaration(meta_js).object_id(result_object_id.clone()).return_by_value(true).build().unwrap()).await {
            Ok(resp) => resp.result.result.value.and_then(|v| v.as_str().and_then(|s| serde_json::from_str(s).ok())).unwrap_or_default(),
            Err(_)   => Vec::new(),
        };

    // Resolve backendNodeIds via DOM.describeNode in parallel.
    let describe_futures = all_metadata.into_iter().enumerate().map(|(i, candidate)| {
        let roid = result_object_id.clone();
        async move { resolve_candidate(page, &roid, i, candidate).await }
    });
    let candidates: Vec<crate::cdp::dom_discovery::DomCandidate> =
        futures_util::future::join_all(describe_futures).await.into_iter().flatten().collect();

    let _ = page.execute(ReleaseObjectParams::new(result_object_id)).await;
    Ok((candidates, inventory))
}

async fn resolve_candidate(
    page: &Page,
    result_object_id: &chromiumoxide::cdp::js_protocol::runtime::RemoteObjectId,
    index: usize,
    mut candidate: crate::cdp::dom_discovery::DomCandidate,
) -> Option<crate::cdp::dom_discovery::DomCandidate> {
    let get_el_js = format!("function() {{ return this.elements[{index}]; }}");
    let el_params = CallFunctionOnParams::builder()
        .function_declaration(&get_el_js)
        .object_id(result_object_id.clone())
        .return_by_value(false)
        .build().ok()?;
    let el_object_id = page.execute(el_params).await.ok()?.result.result.object_id?;
    let el_oid_for_release = el_object_id.clone();
    let describe = DescribeNodeParams::builder().object_id(el_object_id).build();
    let describe_result = page.execute(describe).await;
    let _ = page.execute(ReleaseObjectParams::new(el_oid_for_release)).await;
    let id = *describe_result.ok()?.result.node.backend_node_id.inner();
    if id == 0 { return None; }
    candidate.backend_node_id = id;
    Some(candidate)
}

// ─── Element context helpers ──────────────────────────────────────────────────

fn dom_candidate_json(uid: &str, n: &crate::cdp::dom_discovery::DomCandidate) -> Value {
    let vr = n.viewport_rect.as_ref().map(|r| serde_json::json!({"x":r.x,"y":r.y,"width":r.width,"height":r.height}));
    serde_json::json!({"uid":uid,"role":n.role,"label":n.label,"tag":n.tag,"disabled":n.disabled,"parent_role":n.parent_role,"parent_name":n.parent_name,"accessible_name":n.accessible_name,"visible_text":n.visible_text,"value":n.value,"placeholder":n.placeholder,"title":n.title,"alt_text":n.alt_text,"test_id":n.test_id,"matched_on":n.matched_on,"warnings":n.warnings,"viewport_rect":vr,"in_viewport":n.in_viewport})
}

fn snapshot_node_json(uid: &str, node: &crate::cdp::SnapshotNode) -> Value {
    serde_json::json!({"uid":uid,"role":node.role,"label":node.name})
}

fn nearby_snapshot_candidates(snapshot: &crate::cdp::SnapshotMap, uid: &str, radius: usize) -> Vec<Value> {
    if radius == 0 { return Vec::new(); }
    let Some(index) = snapshot.ordered_uids.iter().position(|u| u == uid) else { return Vec::new(); };
    let start = index.saturating_sub(radius);
    let end   = (index + radius + 1).min(snapshot.ordered_uids.len());
    snapshot.ordered_uids[start..end].iter()
        .filter(|u| u.as_str() != uid)
        .filter_map(|u| {
            snapshot.uid_to_candidate.get(u).map(|c| dom_candidate_json(u, c))
                .or_else(|| snapshot.uid_to_node.get(u).map(|n| snapshot_node_json(u, n)))
        })
        .collect()
}

async fn page_title(page: &Page) -> String {
    let mut ep = EvaluateParams::new("document.title || \"\"");
    ep.return_by_value = Some(true);
    page.execute(ep).await.ok()
        .and_then(|r| r.result.result.value)
        .and_then(|v| v.as_str().map(ToString::to_string))
        .unwrap_or_default()
}

const LIVE_CONTEXT_FN: &str = r#"function(ancestorDepth, siblingLimit, childLimit, maxChars) {
    const normalize = v => (v||"").replace(/\s+/g," ").trim();
    const truncate = v => { const t=normalize(v); return t.length>maxChars?t.substring(0,maxChars):t; };
    const rectFor = el => { const r=el.getBoundingClientRect(); return {x:Math.round(r.x*10)/10,y:Math.round(r.y*10)/10,width:Math.round(r.width*10)/10,height:Math.round(r.height*10)/10}; };
    const roleFor = el => { const a=el.getAttribute("role"); if(a) return a; const tag=el.tagName; if(tag==="BUTTON"||(tag==="INPUT"&&["submit","button","reset"].includes(el.type))) return "button"; if(tag==="A"&&el.hasAttribute("href")) return "link"; if(tag==="INPUT"){const t=el.type||"text";if(t==="checkbox")return "checkbox";if(t==="radio")return "radio";if(t==="search")return "searchbox";return "textbox";} if(tag==="TEXTAREA") return "textbox"; if(tag==="SELECT") return "combobox"; if(el.isContentEditable) return "textbox"; return tag.toLowerCase(); };
    const summarize = el => ({tag:el.tagName.toLowerCase(),role:roleFor(el),text:truncate(el.innerText||el.textContent||""),aria_label:truncate(el.getAttribute("aria-label")||""),title:truncate(el.getAttribute("title")||""),placeholder:truncate(el.getAttribute("placeholder")||el.getAttribute("data-placeholder")||""),value:truncate((el.tagName==="INPUT"||el.tagName==="TEXTAREA"||el.tagName==="SELECT")?el.value:""),test_id:truncate(el.getAttribute("data-testid")||el.getAttribute("data-test")||el.getAttribute("data-cy")||""),disabled:el.disabled===true||el.getAttribute("aria-disabled")==="true",rect:rectFor(el)});
    const ancestors=[]; let parent=this.parentElement; while(parent&&ancestors.length<ancestorDepth){ancestors.push(summarize(parent));parent=parent.parentElement;}
    const siblings=[]; if(this.parentElement){const children=Array.from(this.parentElement.children);const index=children.indexOf(this);const start=Math.max(0,index-siblingLimit);const end=Math.min(children.length,index+siblingLimit+1);for(let i=start;i<end;i++){if(children[i]!==this)siblings.push(summarize(children[i]));}}
    const children=Array.from(this.children).slice(0,childLimit).map(summarize);
    return {element:summarize(this),ancestors,siblings,children};
}"#;

async fn live_element_context(page: &Page, uid: &str, backend_node_id: i64, ancestor_depth: u32, sibling_limit: u32, child_limit: u32, max_chars: u32) -> Result<Value, CallToolResult> {
    let resolve_params = ResolveNodeParams::builder().backend_node_id(BackendNodeId::new(backend_node_id)).build();
    let remote = page.execute(resolve_params).await.map_err(|e| cdp_error(format!("Element uid={uid} could not be resolved: {e}")))?;
    let object_id = remote.result.object.object_id.ok_or_else(|| cdp_error(format!("Element uid={uid} could not be resolved.")))?;

    let call_params = CallFunctionOnParams::builder()
        .function_declaration(LIVE_CONTEXT_FN)
        .object_id(object_id.clone())
        .arguments(vec![
            CallArgument::builder().value(Value::from(ancestor_depth)).build(),
            CallArgument::builder().value(Value::from(sibling_limit)).build(),
            CallArgument::builder().value(Value::from(child_limit)).build(),
            CallArgument::builder().value(Value::from(max_chars)).build(),
        ])
        .return_by_value(true)
        .await_promise(true)
        .build()
        .map_err(|e| cdp_error(format!("Failed to build context params: {e}")))?;

    let resp = page.execute(call_params).await;
    let _ = page.execute(ReleaseObjectParams::new(object_id)).await;
    match resp {
        Ok(r) => {
            if let Some(exc) = &r.result.exception_details { return Err(cdp_error(format!("JS exception: {}", exc.text))); }
            Ok(r.result.result.value.as_ref().cloned().unwrap_or(Value::Null))
        }
        Err(e) => Err(cdp_error(format!("Failed to get element context for uid={uid}: {e}"))),
    }
}

// ─── Public tool functions ────────────────────────────────────────────────────

pub async fn cdp_summarize_page(cdp_client: Arc<RwLock<Option<CdpClient>>>) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };
    let pu   = page_url(&page).await;
    let title = page_title(&page).await;
    let generation = client.generation;
    let walker_js  = crate::cdp::dom_discovery::dom_walker_js("", None, 0);
    let (_candidates, inventory) = match resolve_dom_candidates(&page, &walker_js).await { Ok(r) => r, Err(e) => return e };
    let result = serde_json::json!({"page_url":pu,"title":title,"source":"dom_summary","snapshot_generation":generation,"inventory":inventory});
    CallToolResult::success(vec![Content::text(serde_json::to_string_pretty(&result).unwrap_or_default())])
}

pub async fn cdp_get_element_context(
    uid: String,
    ancestor_depth: Option<u32>,
    sibling_limit:  Option<u32>,
    child_limit:    Option<u32>,
    max_chars:      Option<u32>,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };
    let current_url = page_url(&page).await;

    let snapshot = match client.last_dom_snapshot.as_ref() {
        Some(s) => s,
        None    => return cdp_error("No DOM snapshot. Call cdp_find_elements or cdp_take_dom_snapshot first."),
    };
    let node = match crate::cdp::resolve_uid(&uid, Some(snapshot), client.generation, &current_url) {
        Ok(n)    => n,
        Err(msg) => return cdp_error(msg),
    };

    let generation    = snapshot.generation;
    let stored_element = snapshot.uid_to_candidate.get(&uid).map(|c| dom_candidate_json(&uid, c))
        .unwrap_or_else(|| snapshot_node_json(&uid, node));
    let nearby = nearby_snapshot_candidates(snapshot, &uid, sibling_limit.unwrap_or(2).min(10) as usize);
    let backend_node_id = node.backend_node_id;
    drop(guard);

    let live_context = match live_element_context(&page, &uid, backend_node_id,
        ancestor_depth.unwrap_or(3).min(8),
        sibling_limit.unwrap_or(2).min(10),
        child_limit.unwrap_or(8).min(50),
        max_chars.unwrap_or(240).clamp(40, 1000),
    ).await {
        Ok(c)  => c,
        Err(e) => return e,
    };

    let result = serde_json::json!({"page_url":current_url,"source":"dom_context","uid":uid,"snapshot_generation":generation,"element":stored_element,"nearby_snapshot_matches":nearby,"live_context":live_context});
    CallToolResult::success(vec![Content::text(serde_json::to_string_pretty(&result).unwrap_or_default())])
}

pub async fn cdp_find_elements(
    query:       String,
    role:        Option<String>,
    max_results: Option<u32>,
    cdp_client:  Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let mut guard = cdp_client.write().await;
    let client = match guard.as_mut() { Some(c) => c, None => return cdp_error("No CDP connection.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };

    let max        = max_results.unwrap_or(10);
    let pu         = page_url(&page).await;
    let generation = client.generation;
    let walker_js  = crate::cdp::dom_discovery::dom_walker_js(&query, role.as_deref(), max);

    let (candidates, inventory) = match resolve_dom_candidates(&page, &walker_js).await { Ok(r) => r, Err(e) => return e };

    let snapshot_map = crate::cdp::dom_discovery::build_dom_snapshot(&candidates, pu.clone(), generation);
    let matches_json: Vec<Value> = candidates.iter().enumerate().map(|(i, n)| dom_candidate_json(&format!("d{}", i+1), n)).collect();
    client.last_dom_snapshot = Some(snapshot_map);

    let result = serde_json::json!({"page_url":pu,"source":"dom","matches":matches_json,"inventory":inventory});
    CallToolResult::success(vec![Content::text(serde_json::to_string_pretty(&result).unwrap_or_default())])
}

pub async fn cdp_take_dom_snapshot(
    max_nodes:  Option<u32>,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let mut guard = cdp_client.write().await;
    let client = match guard.as_mut() { Some(c) => c, None => return cdp_error("No CDP connection.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };

    let max        = max_nodes.unwrap_or(500);
    let pu         = page_url(&page).await;
    let generation = client.generation;
    let walker_js  = crate::cdp::dom_discovery::dom_walker_js("", None, max);

    let (candidates, _) = match resolve_dom_candidates(&page, &walker_js).await { Ok(r) => r, Err(e) => return e };

    let snapshot_map = crate::cdp::dom_discovery::build_dom_snapshot(&candidates, pu, generation);
    let output = crate::cdp::dom_discovery::format_dom_snapshot(&candidates);
    client.last_dom_snapshot = Some(snapshot_map);

    CallToolResult::success(vec![Content::text(output)])
}
