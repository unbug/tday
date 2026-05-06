//! CDP input tools: click, hover, fill, press_key, type_text.

use super::{resolve_element_center, resolve_node, resolve_to_object_id};
use crate::cdp::{cdp_error, CdpClient};
use chromiumoxide::cdp::browser_protocol::input::{
    DispatchKeyEventParams, DispatchKeyEventType, DispatchMouseEventParams, DispatchMouseEventType,
    InsertTextParams, MouseButton,
};
use chromiumoxide::cdp::js_protocol::runtime::{CallArgument, CallFunctionOnParams};
use rmcp::model::{CallToolResult, Content};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Maximum nodes for the auto-snapshot appended after actions.
const AUTO_SNAPSHOT_MAX_NODES: u32 = 100;

async fn maybe_append_snapshot(
    mut result: CallToolResult,
    include_snapshot: bool,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    if include_snapshot {
        let snap = super::script::cdp_take_dom_snapshot(Some(AUTO_SNAPSHOT_MAX_NODES), cdp_client).await;
        result.content.extend(snap.content);
    }
    result
}

async fn invalidate_snapshot_cache(cdp_client: Arc<RwLock<Option<CdpClient>>>) {
    if let Some(c) = cdp_client.write().await.as_mut() {
        c.invalidate_snapshots();
    }
}

async fn finish_after_action(
    result: CallToolResult,
    include_snapshot: bool,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    invalidate_snapshot_cache(cdp_client.clone()).await;
    maybe_append_snapshot(result, include_snapshot, cdp_client).await
}

fn observed_fill_status(strategy: &str, observed: &str, value: &str) -> &'static str {
    let matched = if strategy == "select_value" {
        observed.lines().any(|l| l.trim() == value || l.contains(value))
    } else {
        observed.contains(value)
    };
    if matched { "observed_text=true" } else { "observed_text=false" }
}

pub async fn cdp_click(
    uid: String,
    dbl_click: bool,
    include_snapshot: bool,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection. Use cdp_connect first.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };
    let (node_role, node_name, cx, cy) = match resolve_element_center(&uid, client, &page).await { Ok(v) => v, Err(e) => return e };
    drop(guard);

    let n = if dbl_click { 2_i64 } else { 1_i64 };
    let events = vec![
        DispatchMouseEventParams::new(DispatchMouseEventType::MouseMoved, cx, cy),
        {
            let mut e = DispatchMouseEventParams::new(DispatchMouseEventType::MousePressed, cx, cy);
            e.button = Some(MouseButton::Left); e.buttons = Some(1); e.click_count = Some(n); e
        },
        {
            let mut e = DispatchMouseEventParams::new(DispatchMouseEventType::MouseReleased, cx, cy);
            e.button = Some(MouseButton::Left); e.click_count = Some(n); e
        },
    ];
    for ev in events {
        if let Err(e) = page.execute(ev).await {
            return cdp_error(format!("Click failed on uid={uid}: {e}"));
        }
    }
    let dbl = if dbl_click { " (double-click)" } else { "" };
    let result = CallToolResult::success(vec![Content::text(format!(
        "Clicked uid={uid} '{node_name}' ({node_role}) at ({cx:.1}, {cy:.1}){dbl}"
    ))]);
    finish_after_action(result, include_snapshot, cdp_client).await
}

pub async fn cdp_hover(
    uid: String,
    include_snapshot: bool,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection. Use cdp_connect first.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };
    let (node_role, node_name, cx, cy) = match resolve_element_center(&uid, client, &page).await { Ok(v) => v, Err(e) => return e };
    drop(guard);

    if let Err(e) = page.execute(DispatchMouseEventParams::new(DispatchMouseEventType::MouseMoved, cx, cy)).await {
        return cdp_error(format!("Hover failed on uid={uid}: {e}"));
    }
    let result = CallToolResult::success(vec![Content::text(format!(
        "Hovered uid={uid} '{node_name}' ({node_role}) at ({cx:.1}, {cy:.1})"
    ))]);
    finish_after_action(result, include_snapshot, cdp_client).await
}

const FILL_FN: &str = r#"function(value) {
    function textOf(el) {
        if (!el) return "";
        if (el.tagName === "SELECT") {
            const sel = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
            const sv = sel ? sel.value : (el.value||"");
            const st = sel ? (sel.textContent||"").replace(/\s+/g," ").trim() : "";
            return [sv,st].filter(Boolean).join("\n");
        }
        if ("value" in el) return el.value||"";
        return (el.innerText||el.textContent||"").replace(/\s+/g," ").trim();
    }
    function findRichEditor(el) {
        if (el && el.isContentEditable) return el;
        if (!el||!el.querySelector) return null;
        return el.querySelector(["[contenteditable='true']","[contenteditable='plaintext-only']",".ql-editor",".ProseMirror","[data-lexical-editor='true']","[role='textbox'][contenteditable]"].join(","));
    }
    function selectEditableContents(el) {
        el.focus({preventScroll:true});
        const sel=document.getSelection&&document.getSelection();
        if(!sel) return;
        const r=document.createRange(); r.selectNodeContents(el);
        sel.removeAllRanges(); sel.addRange(r);
    }
    function setNativeValue(el,v) {
        const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set;
        if(setter) setter.call(el,v); else el.value=v;
        el.dispatchEvent(new InputEvent("input",{bubbles:true,composed:true,inputType:"insertText",data:v}));
        el.dispatchEvent(new Event("change",{bubbles:true}));
    }
    if(this.tagName==="SELECT"){
        const opt=Array.from(this.options).find(o=>o.value===value||o.textContent.trim()===value);
        if(!opt) throw new Error("Option not found: "+value);
        this.value=opt.value;
        this.dispatchEvent(new Event("input",{bubbles:true}));
        this.dispatchEvent(new Event("change",{bubbles:true}));
        return {strategy:"select_value",observedText:textOf(this)};
    }
    if(this.tagName==="INPUT"||this.tagName==="TEXTAREA"){
        this.focus({preventScroll:true});
        if(this.select) this.select();
        setNativeValue(this,value);
        return {strategy:"native_value_setter",observedText:textOf(this)};
    }
    const rich=findRichEditor(this);
    if(rich){
        selectEditableContents(rich);
        return {strategy:"rich_editor_keyboard",observedText:textOf(rich),targetTag:rich.tagName.toLowerCase(),targetClass:String(rich.className||"")};
    }
    this.focus();
    if(this.select) this.select(); else document.execCommand("selectAll",false,null);
    document.execCommand("insertText",false,value);
    return {strategy:"exec_command",observedText:textOf(this)};
}"#;

const VERIFY_FN: &str = r#"function() {
    function textOf(el) {
        if(!el) return "";
        if(el.tagName==="SELECT"){const s=el.options&&el.selectedIndex>=0?el.options[el.selectedIndex]:null;const sv=s?s.value:(el.value||"");const st=s?(s.textContent||"").replace(/\s+/g," ").trim():"";return [sv,st].filter(Boolean).join("\n");}
        if("value" in el) return el.value||"";
        return (el.innerText||el.textContent||"").replace(/\s+/g," ").trim();
    }
    function findRichEditor(el){if(el&&el.isContentEditable)return el;if(!el||!el.querySelector)return null;return el.querySelector(["[contenteditable='true']","[contenteditable='plaintext-only']",".ql-editor",".ProseMirror","[data-lexical-editor='true']","[role='textbox'][contenteditable]"].join(","));}
    const t=findRichEditor(this)||this;
    return {observedText:textOf(t),active:document.activeElement===t};
}"#;

pub async fn cdp_fill(
    uid: String,
    value: String,
    include_snapshot: bool,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection. Use cdp_connect first.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };
    let current_url = crate::cdp::page_url(&page).await;
    let (backend_node_id, node_role, node_name) = match resolve_node(&uid, client, &current_url) { Ok(v) => v, Err(e) => return e };
    drop(guard);

    let object_id = match resolve_to_object_id(&uid, backend_node_id, &page).await { Ok(id) => id, Err(e) => return e };

    let call_params = match CallFunctionOnParams::builder()
        .function_declaration(FILL_FN)
        .object_id(object_id.clone())
        .arguments(vec![CallArgument::builder().value(Value::String(value.clone())).build()])
        .await_promise(true)
        .return_by_value(true)
        .build()
    {
        Ok(p) => p,
        Err(e) => return cdp_error(format!("Failed to build fill params: {e}")),
    };

    let prep = match page.execute(call_params).await {
        Ok(resp) => {
            if let Some(exc) = &resp.result.exception_details { return cdp_error(format!("Fill failed: {}", exc.text)); }
            resp.result.result.value.unwrap_or(Value::Null)
        }
        Err(e) => return cdp_error(format!("Fill failed on uid={uid}: {e}")),
    };

    let strategy = prep.get("strategy").and_then(Value::as_str).unwrap_or("unknown");
    if strategy == "rich_editor_keyboard" {
        if let Err(e) = page.execute(InsertTextParams::new(value.clone())).await {
            return cdp_error(format!("Fill failed on uid={uid} with CDP text insertion: {e}"));
        }
    }

    let verify_params = match CallFunctionOnParams::builder()
        .function_declaration(VERIFY_FN)
        .object_id(object_id)
        .return_by_value(true)
        .await_promise(true)
        .build()
    {
        Ok(p) => p,
        Err(e) => return cdp_error(format!("Failed to build verify params: {e}")),
    };
    let observed_text = match page.execute(verify_params).await {
        Ok(resp) => {
            if let Some(exc) = &resp.result.exception_details { return cdp_error(format!("Fill verify failed: {}", exc.text)); }
            resp.result.result.value
                .and_then(|v| v.get("observedText").and_then(Value::as_str).map(str::to_string))
                .unwrap_or_default()
        }
        Err(e) => return cdp_error(format!("Fill verify failed on uid={uid}: {e}")),
    };

    let observed = observed_fill_status(strategy, &observed_text, &value);
    let rich_hint = if strategy == "rich_editor_keyboard" {
        "; rich editor used CDP keyboard insertion. If ready, use cdp_press_key({\"key\":\"Enter\"}) or click Send to submit."
    } else {
        ""
    };

    let result = CallToolResult::success(vec![Content::text(format!(
        "Filled uid={uid} '{node_name}' ({node_role}) with '{value}' (strategy={strategy}, {observed}{rich_hint})"
    ))]);
    finish_after_action(result, include_snapshot, cdp_client).await
}

// ─── Key dispatch helpers ─────────────────────────────────────────────────────

fn key_definition(key: &str) -> Option<(&'static str, &'static str, i64)> {
    Some(match key {
        "Enter"      => ("Enter",     "Enter",     13),
        "Tab"        => ("Tab",       "Tab",        9),
        "Escape"     => ("Escape",    "Escape",    27),
        "Backspace"  => ("Backspace", "Backspace",  8),
        "Delete"     => ("Delete",    "Delete",    46),
        "ArrowUp"    => ("ArrowUp",   "ArrowUp",   38),
        "ArrowDown"  => ("ArrowDown", "ArrowDown", 40),
        "ArrowLeft"  => ("ArrowLeft", "ArrowLeft", 37),
        "ArrowRight" => ("ArrowRight","ArrowRight",39),
        "Home"       => ("Home",      "Home",      36),
        "End"        => ("End",       "End",       35),
        "PageUp"     => ("PageUp",    "PageUp",    33),
        "PageDown"   => ("PageDown",  "PageDown",  34),
        "Space" | " " => (" ",        "Space",     32),
        "F1"  => ("F1",  "F1",  112), "F2"  => ("F2",  "F2",  113),
        "F3"  => ("F3",  "F3",  114), "F4"  => ("F4",  "F4",  115),
        "F5"  => ("F5",  "F5",  116), "F6"  => ("F6",  "F6",  117),
        "F7"  => ("F7",  "F7",  118), "F8"  => ("F8",  "F8",  119),
        "F9"  => ("F9",  "F9",  120), "F10" => ("F10", "F10", 121),
        "F11" => ("F11", "F11", 122), "F12" => ("F12", "F12", 123),
        _ => return None,
    })
}

fn char_key_code(ch: char) -> (&'static str, i64) {
    match ch {
        'a'..='z' | 'A'..='Z' => {
            let u = ch.to_ascii_uppercase();
            let code: &'static str = match u {
                'A' => "KeyA", 'B' => "KeyB", 'C' => "KeyC", 'D' => "KeyD", 'E' => "KeyE",
                'F' => "KeyF", 'G' => "KeyG", 'H' => "KeyH", 'I' => "KeyI", 'J' => "KeyJ",
                'K' => "KeyK", 'L' => "KeyL", 'M' => "KeyM", 'N' => "KeyN", 'O' => "KeyO",
                'P' => "KeyP", 'Q' => "KeyQ", 'R' => "KeyR", 'S' => "KeyS", 'T' => "KeyT",
                'U' => "KeyU", 'V' => "KeyV", 'W' => "KeyW", 'X' => "KeyX", 'Y' => "KeyY",
                'Z' => "KeyZ", _ => unreachable!(),
            };
            (code, u as i64)
        }
        '0' => ("Digit0", 0x30), '1' => ("Digit1", 0x31), '2' => ("Digit2", 0x32),
        '3' => ("Digit3", 0x33), '4' => ("Digit4", 0x34), '5' => ("Digit5", 0x35),
        '6' => ("Digit6", 0x36), '7' => ("Digit7", 0x37), '8' => ("Digit8", 0x38),
        '9' => ("Digit9", 0x39),
        '-' => ("Minus",       0xBD), '=' | '+' => ("Equal",     0xBB),
        '[' => ("BracketLeft", 0xDB), ']'        => ("BracketRight",0xDD),
        '\\' => ("Backslash",  0xDC), ';'        => ("Semicolon", 0xBA),
        '\'' => ("Quote",      0xDE), ','        => ("Comma",     0xBC),
        '.' => ("Period",      0xBE), '/'        => ("Slash",     0xBF),
        '`' => ("Backquote",   0xC0),
        _   => ("Unidentified", 0),
    }
}

const MODIFIER_ALT: i64     = 1;
const MODIFIER_CONTROL: i64 = 2;
const MODIFIER_META: i64    = 4;
const MODIFIER_SHIFT: i64   = 8;

fn modifier_bit(name: &str) -> Option<i64> {
    match name {
        "Alt" => Some(MODIFIER_ALT), "Control" => Some(MODIFIER_CONTROL),
        "Meta" => Some(MODIFIER_META), "Shift" => Some(MODIFIER_SHIFT),
        _ => None,
    }
}

struct ParsedKeyCombo { modifiers: i64, modifier_names: Vec<String>, main_key: String }

fn parse_key_combo(key: &str) -> Result<ParsedKeyCombo, String> {
    let parts: Vec<&str> = key.split('+').collect();
    let (mod_parts, main_key) = if key.ends_with("++") {
        (&parts[..parts.len()-2], "+")
    } else if parts.len() > 1 {
        (&parts[..parts.len()-1], *parts.last().unwrap_or(&""))
    } else {
        (&[][..], parts[0])
    };
    let mut modifiers = 0i64;
    let mut modifier_names = Vec::new();
    for &m in mod_parts {
        match modifier_bit(m) {
            Some(b) => { modifiers |= b; modifier_names.push(m.to_string()); }
            None    => return Err(m.to_string()),
        }
    }
    Ok(ParsedKeyCombo { modifiers, modifier_names, main_key: main_key.to_string() })
}

async fn dispatch_named_key(page: &chromiumoxide::page::Page, key_val: &str, code: &str, vk: i64, modifiers: i64) -> Result<(), String> {
    let mut d = DispatchKeyEventParams::new(DispatchKeyEventType::RawKeyDown);
    d.key = Some(key_val.to_string()); d.code = Some(code.to_string());
    d.windows_virtual_key_code = Some(vk); d.modifiers = Some(modifiers);
    page.execute(d).await.map_err(|e| format!("Failed to press key {key_val}: {e}"))?;

    let mut u = DispatchKeyEventParams::new(DispatchKeyEventType::KeyUp);
    u.key = Some(key_val.to_string()); u.code = Some(code.to_string());
    u.windows_virtual_key_code = Some(vk); u.modifiers = Some(modifiers);
    page.execute(u).await.map_err(|e| format!("Failed to release key {key_val}: {e}"))?;
    Ok(())
}

async fn dispatch_char(page: &chromiumoxide::page::Page, ch: char, modifiers: i64) -> Result<(), String> {
    let (code, vk) = char_key_code(ch);
    let mut d = DispatchKeyEventParams::new(DispatchKeyEventType::RawKeyDown);
    d.key = Some(ch.to_string()); d.code = Some(code.to_string());
    d.windows_virtual_key_code = Some(vk); d.modifiers = Some(modifiers);
    page.execute(d).await.map_err(|e| format!("Failed to press char {ch}: {e}"))?;

    if modifiers == 0 || modifiers == MODIFIER_SHIFT {
        let mut c = DispatchKeyEventParams::new(DispatchKeyEventType::Char);
        c.text = Some(ch.to_string()); c.modifiers = Some(modifiers);
        let _ = page.execute(c).await;
    }

    let mut u = DispatchKeyEventParams::new(DispatchKeyEventType::KeyUp);
    u.key = Some(ch.to_string()); u.code = Some(code.to_string());
    u.windows_virtual_key_code = Some(vk); u.modifiers = Some(modifiers);
    page.execute(u).await.map_err(|e| format!("Failed to release char {ch}: {e}"))?;
    Ok(())
}

pub async fn cdp_press_key(
    key: String,
    include_snapshot: bool,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection. Use cdp_connect first.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };
    drop(guard);

    let combo = match parse_key_combo(&key) {
        Ok(c) => c,
        Err(u) => return cdp_error(format!("Unknown modifier '{u}'. Use Control, Shift, Alt, or Meta.")),
    };
    let (modifiers, main_key) = (combo.modifiers, &combo.main_key.clone());

    for m in &combo.modifier_names {
        let mut p = DispatchKeyEventParams::new(DispatchKeyEventType::KeyDown);
        p.key = Some(m.clone()); p.modifiers = Some(modifiers);
        if let Err(e) = page.execute(p).await { return cdp_error(format!("Failed to press modifier {m}: {e}")); }
    }

    if let Some((kv, code, vk)) = key_definition(main_key) {
        if let Err(e) = dispatch_named_key(&page, kv, code, vk, modifiers).await { return cdp_error(e); }
    } else if main_key.len() == 1 {
        let ch = main_key.chars().next().unwrap_or(' ');
        if let Err(e) = dispatch_char(&page, ch, modifiers).await { return cdp_error(e); }
    } else {
        return cdp_error(format!("Unknown key '{main_key}'. Use key names like Enter, Tab, ArrowUp, or single characters."));
    }

    for m in combo.modifier_names.iter().rev() {
        let mut p = DispatchKeyEventParams::new(DispatchKeyEventType::KeyUp);
        p.key = Some(m.clone());
        let _ = page.execute(p).await;
    }

    let result = CallToolResult::success(vec![Content::text(format!("Pressed key: {key}"))]);
    finish_after_action(result, include_snapshot, cdp_client).await
}

pub async fn cdp_type_text(
    text: String,
    submit_key: Option<String>,
    cdp_client: Arc<RwLock<Option<CdpClient>>>,
) -> CallToolResult {
    let guard = cdp_client.read().await;
    let client = match guard.as_ref() { Some(c) => c, None => return cdp_error("No CDP connection. Use cdp_connect first.") };
    let page = match client.require_page() { Ok(p) => p, Err(e) => return e };

    let submit_def = if let Some(ref sk) = submit_key {
        match key_definition(sk) {
            Some(d) => Some(d),
            None => return cdp_error(format!("Unknown submit key '{sk}'.")),
        }
    } else { None };
    drop(guard);

    for ch in text.chars() {
        if let Err(e) = dispatch_char(&page, ch, 0).await { return cdp_error(e); }
    }
    if let Some((kv, code, vk)) = submit_def {
        if let Err(e) = dispatch_named_key(&page, kv, code, vk, 0).await { return cdp_error(e); }
    }

    let suffix = submit_key.as_deref().map(|k| format!(" + {k}")).unwrap_or_default();
    invalidate_snapshot_cache(cdp_client).await;
    CallToolResult::success(vec![Content::text(format!("Typed text \"{text}{suffix}\""))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn key_definition_enter() { let (k,c,v) = key_definition("Enter").unwrap(); assert_eq!(k,"Enter"); assert_eq!(c,"Enter"); assert_eq!(v,13); }
    #[test] fn key_definition_tab()   { assert_eq!(key_definition("Tab").unwrap().2, 9); }
    #[test] fn key_definition_arrow_keys() { assert_eq!(key_definition("ArrowUp").unwrap().2,38); assert_eq!(key_definition("ArrowDown").unwrap().2,40); }
    #[test] fn key_definition_space() { let (k,_,v) = key_definition("Space").unwrap(); assert_eq!(k," "); assert_eq!(v,32); }
    #[test] fn key_definition_f_keys() { assert_eq!(key_definition("F1").unwrap().2,112); assert_eq!(key_definition("F12").unwrap().2,123); }
    #[test] fn key_definition_none_single_char() { assert!(key_definition("a").is_none()); }
    #[test] fn key_definition_none_unknown() { assert!(key_definition("FooBar").is_none()); }

    #[test] fn modifier_bit_values() { assert_eq!(modifier_bit("Alt"),Some(1)); assert_eq!(modifier_bit("Control"),Some(2)); assert_eq!(modifier_bit("Meta"),Some(4)); assert_eq!(modifier_bit("Shift"),Some(8)); }
    #[test] fn modifier_bit_none()   { assert_eq!(modifier_bit("Ctrl"), None); }

    #[test] fn parse_single_key() { let c = parse_key_combo("Enter").unwrap(); assert_eq!(c.main_key,"Enter"); assert_eq!(c.modifiers,0); }
    #[test] fn parse_control_a()  { let c = parse_key_combo("Control+A").unwrap(); assert_eq!(c.main_key,"A"); assert_eq!(c.modifiers, MODIFIER_CONTROL); }
    #[test] fn parse_control_shift_r() { let c = parse_key_combo("Control+Shift+R").unwrap(); assert_eq!(c.modifiers, MODIFIER_CONTROL|MODIFIER_SHIFT); }
    #[test] fn parse_control_plus_key() { let c = parse_key_combo("Control++").unwrap(); assert_eq!(c.main_key,"+"); assert_eq!(c.modifiers, MODIFIER_CONTROL); }
    #[test] fn parse_unknown_modifier_err() { assert!(parse_key_combo("Ctrl+A").is_err()); }

    #[test] fn char_key_code_letters() { assert_eq!(char_key_code('a'),("KeyA",65)); assert_eq!(char_key_code('Z'),("KeyZ",90)); }
    #[test] fn char_key_code_digits()  { assert_eq!(char_key_code('0'),("Digit0",0x30)); assert_eq!(char_key_code('9'),("Digit9",0x39)); }
    #[test] fn char_key_code_punct()   { assert_eq!(char_key_code('+'),("Equal",0xBB)); assert_eq!(char_key_code('/'),("Slash",0xBF)); }
    #[test] fn char_key_code_unknown() { assert_eq!(char_key_code('€'),("Unidentified",0)); }

    #[test] fn observed_fill_status_select() {
        assert_eq!(observed_fill_status("select_value","us\nUnited States","us"),"observed_text=true");
        assert_eq!(observed_fill_status("select_value","us\nUnited States","United States"),"observed_text=true");
    }
}
