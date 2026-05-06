//! DOM-native discovery for CDP-connected pages.
//!
//! Walks the live DOM via `Runtime.evaluate` to find interactive elements,
//! extracts semantic labels, and assigns `d<N>` prefixed UIDs.

use super::{SnapshotMap, SnapshotNode};
use std::collections::HashMap;

/// Viewport-relative bounding box of a DOM element.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct DomRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A candidate element extracted from the live DOM.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
pub struct DomCandidate {
    #[serde(rename = "backendNodeId")]
    pub backend_node_id: i64,
    pub role: String,
    pub label: String,
    pub tag: String,
    pub disabled: bool,
    #[serde(rename = "parentRole")]
    pub parent_role: String,
    #[serde(rename = "parentName")]
    pub parent_name: String,
    #[serde(rename = "accessibleName", default)]
    pub accessible_name: String,
    #[serde(rename = "visibleText", default)]
    pub visible_text: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub placeholder: String,
    #[serde(default)]
    pub title: String,
    #[serde(rename = "altText", default)]
    pub alt_text: String,
    #[serde(rename = "testId", default)]
    pub test_id: String,
    #[serde(rename = "matchedOn", default)]
    pub matched_on: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(rename = "viewportRect", default)]
    pub viewport_rect: Option<DomRect>,
    #[serde(rename = "inViewport", default)]
    pub in_viewport: bool,
}

/// Build a [`SnapshotMap`] from DOM candidates, assigning `d<N>` UIDs.
///
/// `page_url` and `generation` are stamped onto the snapshot so stale
/// entries can be detected at lookup time.
pub fn build_dom_snapshot(
    candidates: &[DomCandidate],
    page_url: String,
    generation: u64,
) -> SnapshotMap {
    let mut uid_to_node      = HashMap::new();
    let mut uid_to_candidate = HashMap::new();
    let mut backend_to_uids: HashMap<i64, Vec<String>> = HashMap::new();
    let mut ordered_uids     = Vec::with_capacity(candidates.len());

    for (i, candidate) in candidates.iter().enumerate() {
        let uid = format!("d{}", i + 1);
        ordered_uids.push(uid.clone());

        uid_to_node.insert(
            uid.clone(),
            SnapshotNode {
                backend_node_id: candidate.backend_node_id,
                role: candidate.role.clone(),
                name: snapshot_display_name(candidate),
            },
        );
        uid_to_candidate.insert(uid.clone(), candidate.clone());

        if candidate.backend_node_id != 0 {
            backend_to_uids
                .entry(candidate.backend_node_id)
                .or_default()
                .push(uid);
        }
    }

    SnapshotMap {
        uid_to_node,
        uid_to_candidate,
        backend_to_uids,
        ordered_uids,
        page_url,
        generation,
    }
}

/// Choose the best human-readable name for a snapshot entry.
fn snapshot_display_name(c: &DomCandidate) -> String {
    for s in [
        &c.accessible_name,
        &c.label,
        &c.visible_text,
        &c.placeholder,
        &c.title,
        &c.alt_text,
    ] {
        if !s.is_empty() {
            return s.clone();
        }
    }
    c.role.clone()
}

/// Build the DOM walker JavaScript string with embedded query/role/max constraints.
///
/// The returned JS evaluates to `{ elements, metadata, inventory }` where
/// `elements` is a live `NodeList` (kept as references for `describeNode`),
/// `metadata` is a JSON-serialisable parallel array, and `inventory`
/// summarises role counts for `cdp_summarize_page`.
pub fn dom_walker_js(query: &str, role_filter: Option<&str>, max_results: u32) -> String {
    let query_json = serde_json::to_string(query).unwrap();
    let role_json  = role_filter
        .map(|r| serde_json::to_string(r).unwrap())
        .unwrap_or_else(|| "null".to_string());

    format!(
        r##"(() => {{
const QUERY = {query_json};
const ROLE_FILTER = {role_json};
const MAX = {max_results};

const INTERACTIVE_TAGS = new Set(["BUTTON","A","INPUT","TEXTAREA","SELECT","SUMMARY"]);
const INTERACTIVE_ROLES = new Set([
  "button","checkbox","combobox","link","menuitem","menuitemcheckbox",
  "menuitemradio","option","radio","searchbox","slider","spinbutton",
  "switch","tab","textbox","treeitem"
]);

function isVisible(el) {{
  if (el.closest("[aria-hidden='true']") || el.closest("[inert]")) return false;
  const s = getComputedStyle(el);
  if (s.display==="none" || s.visibility==="hidden") return false;
  if (el.offsetWidth===0 && el.offsetHeight===0) return false;
  return true;
}}
function normalizeText(v) {{ return (v||"").replace(/\s+/g," ").trim(); }}
function truncate(v,max) {{ const t=normalizeText(v); return t.length>max?t.substring(0,max):t; }}
function labelledByText(el) {{
  const lb=el.getAttribute("aria-labelledby"); if(!lb) return "";
  return lb.split(/\s+/).map(id=>{{const r=el.getRootNode();const ref_=r&&r.getElementById?r.getElementById(id):null;return ref_?ref_.textContent:"";}}).filter(Boolean).join(" ");
}}
function labelElementText(el) {{
  if(!el.labels||!el.labels.length) return "";
  return Array.from(el.labels).map(l=>l.textContent).join(" ");
}}
function formValue(el) {{
  if(el.tagName==="INPUT"||el.tagName==="TEXTAREA"||el.tagName==="SELECT") return el.value||"";
  return "";
}}
function explicitAccessibleName(el) {{
  const al=el.getAttribute("aria-label"); if(al) return al;
  const lb=labelledByText(el); if(lb) return lb;
  const lt=labelElementText(el); if(lt) return lt;
  const ph=el.getAttribute("placeholder")||el.getAttribute("data-placeholder"); if(ph) return ph;
  if(el.tagName==="INPUT"&&["submit","button","reset"].includes(el.type)){{const v=formValue(el);if(v) return v;}}
  const t=el.getAttribute("title"); if(t) return t;
  const a=el.getAttribute("alt"); if(a) return a;
  return "";
}}
function hasOwnLabel(el) {{
  return el.hasAttribute("aria-label")||el.hasAttribute("aria-labelledby")||el.hasAttribute("title")||el.hasAttribute("alt")||el.hasAttribute("role")||el.hasAttribute("data-testid");
}}
function ownTextNodes(el) {{
  let out="";
  for(const c of el.childNodes) {{ if(c.nodeType===Node.TEXT_NODE) out+=c.nodeValue; }}
  return out.replace(/\s+/g," ").trim();
}}
function directOwnText(el) {{
  let out="";
  for(const c of el.childNodes) {{
    if(c.nodeType===Node.TEXT_NODE) out+=c.nodeValue;
    else if(c.nodeType===Node.ELEMENT_NODE) {{
      if(hasOwnLabel(c)||isInteractive(c)) continue;
      out+=" "+directOwnText(c);
    }}
  }}
  return out.replace(/\s+/g," ").trim();
}}
function getLabel(el) {{
  const al=el.getAttribute("aria-label"); if(al) return al.trim();
  const lb=labelledByText(el); if(lb) return normalizeText(lb);
  const lt=labelElementText(el); if(lt) return normalizeText(lt);
  const ph=el.getAttribute("placeholder")||el.getAttribute("data-placeholder"); if(ph) return ph.trim();
  if(el.tagName==="INPUT"&&["submit","button","reset"].includes(el.type)) {{ if(el.value) return el.value.trim(); }}
  const t=el.getAttribute("title"); if(t) return t.trim();
  const a=el.getAttribute("alt"); if(a) return a.trim();
  const own=ownTextNodes(el); if(own) return own.substring(0,200);
  const nested=directOwnText(el).trim().substring(0,200); if(nested) return nested;
  return el.tagName.toLowerCase();
}}
function getVisibleText(el) {{
  const inner=truncate(el.innerText||"",300); if(inner) return inner;
  const own=ownTextNodes(el); if(own) return truncate(own,300);
  return truncate(directOwnText(el),300);
}}
function getRole(el) {{
  const ar=el.getAttribute("role"); if(ar&&INTERACTIVE_ROLES.has(ar)) return ar;
  const tag=el.tagName;
  if(tag==="BUTTON"||(tag==="INPUT"&&["submit","button","reset"].includes(el.type))) return "button";
  if(tag==="A"&&el.hasAttribute("href")) return "link";
  if(tag==="INPUT") {{
    const t=el.type||"text";
    if(t==="checkbox") return "checkbox"; if(t==="radio") return "radio";
    if(t==="search") return "searchbox"; if(t==="range") return "slider";
    if(t==="number") return "spinbutton"; return "textbox";
  }}
  if(tag==="TEXTAREA") return "textbox";
  if(tag==="SELECT") return "combobox";
  if(tag==="SUMMARY") return "button";
  if(el.isContentEditable) return "textbox";
  if(ar) return ar;
  return "generic";
}}
function getParentContext(el) {{
  let p=el.parentElement;
  while(p) {{
    const r=p.getAttribute("role");
    if(r) {{ const n=p.getAttribute("aria-label")||p.textContent?.trim().substring(0,50)||""; return {{role:r,name:n}}; }}
    const tag=p.tagName;
    if(["NAV","MAIN","ASIDE","HEADER","FOOTER","SECTION","FORM","DIALOG"].includes(tag)) {{ return {{role:tag.toLowerCase(),name:p.getAttribute("aria-label")||""}}; }}
    p=p.parentElement;
  }}
  return {{role:"",name:""}};
}}
function viewportRect(el) {{
  const r=el.getBoundingClientRect();
  return {{x:Math.round(r.x*10)/10,y:Math.round(r.y*10)/10,width:Math.round(r.width*10)/10,height:Math.round(r.height*10)/10}};
}}
function intersectsViewport(r) {{
  return r.width>0&&r.height>0&&r.x<window.innerWidth&&r.y<window.innerHeight&&r.x+r.width>0&&r.y+r.height>0;
}}
function matchFields(fields) {{
  if(!queryLower) return [];
  const m=[];
  for(const [k,v] of Object.entries(fields)) {{ if(v&&v.toLowerCase().includes(queryLower)) m.push(k); }}
  return m;
}}
function meaningfullyDifferent(a,b) {{
  const l=normalizeText(a).toLowerCase(); const r=normalizeText(b).toLowerCase();
  if(!l||!r||l===r) return false;
  return !l.includes(r)&&!r.includes(l);
}}
function isInteractive(el) {{
  if(INTERACTIVE_TAGS.has(el.tagName)) return true;
  if(el.isContentEditable&&(!el.parentElement||!el.parentElement.isContentEditable)) return true;
  const r=el.getAttribute("role"); if(r&&INTERACTIVE_ROLES.has(r)) return true;
  const ti=el.getAttribute("tabindex"); if(ti!==null&&parseInt(ti,10)>=0) return true;
  return false;
}}
function walk(root,results) {{
  for(const el of root.querySelectorAll("*")) {{
    if(isInteractive(el)) results.push(el);
    if(el.shadowRoot) walk(el.shadowRoot,results);
  }}
  if(root===document) {{
    for(const f of document.querySelectorAll("iframe")) {{
      try {{ if(f.contentDocument) walk(f.contentDocument,results); }} catch(e) {{}}
    }}
  }}
}}

const allElements=[]; walk(document,allElements);
const queryLower=QUERY.toLowerCase();
const matched=[]; const roleCounts={{}};

for(const el of allElements) {{
  const label=getLabel(el); const role=getRole(el);
  if(!roleCounts[role]) roleCounts[role]={{count:0,labels:[]}};
  roleCounts[role].count++;
  const invLabel=label||(roleCounts[role].labels.length<3?getVisibleText(el):"");
  if(roleCounts[role].labels.length<3&&invLabel) roleCounts[role].labels.push(invLabel.substring(0,80));
  if(MAX===0) continue;
  const accessibleName=truncate(explicitAccessibleName(el),200);
  const visibleText=getVisibleText(el);
  const value=truncate(formValue(el),200);
  const placeholder=truncate(el.getAttribute("placeholder")||el.getAttribute("data-placeholder")||"",200);
  const title=truncate(el.getAttribute("title")||"",200);
  const altText=truncate(el.getAttribute("alt")||"",200);
  const testId=truncate(el.getAttribute("data-testid")||el.getAttribute("data-test")||el.getAttribute("data-cy")||"",200);
  if(ROLE_FILTER&&role!==ROLE_FILTER) continue;
  const parent=getParentContext(el);
  const matchedOn=matchFields({{label,accessible_name:accessibleName,visible_text:visibleText,value,placeholder,title,alt_text:altText,test_id:testId}});
  if(queryLower&&matchedOn.length===0) continue;
  if(!isVisible(el)) continue;
  const tag=el.tagName.toLowerCase();
  const disabled=el.disabled===true||el.getAttribute("aria-disabled")==="true";
  const rect=viewportRect(el); const inViewport=intersectsViewport(rect);
  const warnings=[];
  if(meaningfullyDifferent(accessibleName,visibleText)) warnings.push("accessible_name_visible_text_mismatch");
  if(!inViewport) warnings.push("outside_viewport");
  matched.push({{el,metadata:{{backendNodeId:0,role,label:label.substring(0,200),tag,disabled,parentRole:parent.role,parentName:truncate(parent.name,100),accessibleName,visibleText,value,placeholder,title,altText,testId,matchedOn,warnings,viewportRect:rect,inViewport}}}});
}}

matched.sort((a,b)=>{{
  if(a.metadata.inViewport!==b.metadata.inViewport) return a.metadata.inViewport?-1:1;
  if(a.metadata.viewportRect.y!==b.metadata.viewportRect.y) return a.metadata.viewportRect.y-b.metadata.viewportRect.y;
  return a.metadata.viewportRect.x-b.metadata.viewportRect.x;
}});

const selected=matched.slice(0,MAX);
const matchedElements=selected.map(i=>i.el);
const metadataArray=selected.map(i=>i.metadata);
const inventory=Object.entries(roleCounts).map(([role,data])=>{{return {{role,count:data.count,sample_labels:data.labels}};}});
return {{elements:matchedElements,metadata:metadataArray,inventory}};
}})()"##
    )
}

/// Format DOM candidates as an indented text snapshot (similar to AX format).
pub fn format_dom_snapshot(candidates: &[DomCandidate]) -> String {
    let mut lines = Vec::with_capacity(candidates.len());
    for (i, node) in candidates.iter().enumerate() {
        let mut parts = vec![format!("uid=d{} {}", i + 1, node.role)];
        if !node.label.is_empty() { parts.push(format!("\"{}\"", node.label)); }
        if !node.accessible_name.is_empty() && node.accessible_name != node.label {
            parts.push(format!("accessible_name=\"{}\"", node.accessible_name));
        }
        if !node.visible_text.is_empty() && node.visible_text != node.label {
            parts.push(format!("visible_text=\"{}\"", node.visible_text));
        }
        if !node.value.is_empty() && node.value != node.label {
            parts.push(format!("value=\"{}\"", node.value));
        }
        if !node.placeholder.is_empty() && node.placeholder != node.label {
            parts.push(format!("placeholder=\"{}\"", node.placeholder));
        }
        if !node.title.is_empty() && node.title != node.label {
            parts.push(format!("title=\"{}\"", node.title));
        }
        if !node.alt_text.is_empty() && node.alt_text != node.label {
            parts.push(format!("alt=\"{}\"", node.alt_text));
        }
        if !node.test_id.is_empty() { parts.push(format!("test_id=\"{}\"", node.test_id)); }
        parts.push(format!("tag={}", node.tag));
        if node.disabled { parts.push("disabled".to_string()); }
        if let Some(rect) = &node.viewport_rect {
            parts.push(format!("rect=({:.0},{:.0} {:.0}x{:.0})", rect.x, rect.y, rect.width, rect.height));
            if !node.in_viewport { parts.push("offscreen".to_string()); }
        }
        if !node.matched_on.is_empty() { parts.push(format!("matched_on={}", node.matched_on.join(","))); }
        if !node.warnings.is_empty()   { parts.push(format!("warnings={}", node.warnings.join(","))); }
        if !node.parent_role.is_empty() {
            if node.parent_name.is_empty() {
                parts.push(format!("(in {})", node.parent_role));
            } else {
                parts.push(format!("(in {} \"{}\")", node.parent_role, node.parent_name));
            }
        }
        lines.push(parts.join(" "));
    }
    lines.join("\n")
}

/// JavaScript injected into the page to collect interactive elements.
#[allow(dead_code)]
pub const DOM_DISCOVERY_SCRIPT: &str = r#"
(function(maxNodes) {
  const MAX = maxNodes || 500;
  const results = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let count = 0;
  while (walker.nextNode() && count < MAX) {
    const el = walker.currentNode;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const label = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '';
    const text  = (el.textContent || '').trim().slice(0, 200);
    const placeholder = el.getAttribute('placeholder') || '';
    const title       = el.getAttribute('title') || '';
    const alt         = el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '';
    const testId      = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '';
    const disabled    = el.disabled || el.getAttribute('aria-disabled') === 'true';

    // Only include interactive or labelled elements.
    const isInteractive = ['a','button','input','select','textarea','details','summary']
      .includes(el.tagName.toLowerCase());
    const hasLabel = label || text || placeholder || title || alt;
    if (!isInteractive && !hasLabel) continue;

    results.push({
      backendNodeId: 0,   // will be filled by caller via DOM.resolveNode if needed
      role,
      label,
      tag: el.tagName.toLowerCase(),
      disabled,
      accessibleName: el.getAttribute('aria-label') || '',
      visibleText: text,
      value: el.value || '',
      placeholder,
      title,
      altText: alt,
      testId,
      parentRole: el.parentElement ? (el.parentElement.getAttribute('role') || el.parentElement.tagName.toLowerCase()) : '',
      parentName: (el.parentElement ? (el.parentElement.textContent || '').trim().slice(0, 100) : ''),
      viewportRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      inViewport: rect.top >= 0 && rect.left >= 0 &&
                  rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
    });
    count++;
  }
  return results;
})(arguments[0]);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn make_candidate(id: i64, role: &str, label: &str) -> DomCandidate {
        DomCandidate {
            backend_node_id: id,
            role: role.to_string(),
            label: label.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn build_snapshot_assigns_uids() {
        let candidates = vec![
            make_candidate(1, "button", "OK"),
            make_candidate(2, "input",  "Email"),
        ];
        let map = build_dom_snapshot(&candidates, "https://example.com".to_string(), 0);
        assert_eq!(map.ordered_uids, vec!["d1", "d2"]);
        assert!(map.uid_to_node.contains_key("d1"));
        assert!(map.uid_to_node.contains_key("d2"));
    }

    #[test]
    fn build_snapshot_backend_reverse_map() {
        let candidates = vec![make_candidate(42, "link", "Click me")];
        let map = build_dom_snapshot(&candidates, "https://example.com".to_string(), 0);
        assert_eq!(map.backend_to_uids[&42], vec!["d1"]);
    }

    #[test]
    fn build_snapshot_stamps_generation() {
        let map = build_dom_snapshot(&[], "https://x.com".to_string(), 7);
        assert_eq!(map.generation, 7);
        assert_eq!(map.page_url, "https://x.com");
    }

    #[test]
    fn snapshot_display_name_prefers_accessible_name() {
        let mut c = make_candidate(1, "button", "label");
        c.accessible_name = "accessible".to_string();
        assert_eq!(snapshot_display_name(&c), "accessible");
    }
}
