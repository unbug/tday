use serde::{Deserialize, Serialize};

// ──────────────────────────────────────────────────────────────────────────────
// Window
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub id: u32,
    pub name: Option<String>,
    pub owner_name: String,
    pub owner_pid: i64,
    pub bounds: Rect,
    pub layer: i64,
    pub is_on_screen: bool,
}

// ──────────────────────────────────────────────────────────────────────────────
// App
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub is_active: bool,
    pub is_hidden: bool,
    #[serde(skip)]
    pub is_user_app: bool,
}

// ──────────────────────────────────────────────────────────────────────────────
// Display
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub name: Option<String>,
    pub is_main: bool,
    pub bounds: Rect,
    pub backing_scale_factor: f64,
    pub pixel_width: u32,
    pub pixel_height: u32,
}

// ──────────────────────────────────────────────────────────────────────────────
// Geometry
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains_point(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Screenshot
// ──────────────────────────────────────────────────────────────────────────────

/// Raw screenshot data plus coordinate metadata.
pub struct Screenshot {
    pub png_data: Vec<u8>,
    /// Backing-pixel scale factor of the display (e.g. 2.0 for Retina).
    pub scale_factor: f64,
    /// Top-left origin in screen points.
    pub origin_x: f64,
    pub origin_y: f64,
    /// Pixel dimensions of the captured image.
    pub pixel_width: u32,
    pub pixel_height: u32,
}

// ──────────────────────────────────────────────────────────────────────────────
// OCR
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextMatch {
    pub text: String,
    /// Screen-point X of the element centre.
    pub x: f64,
    /// Screen-point Y of the element centre.
    pub y: f64,
    pub confidence: f64,
    pub bounds: Rect,
    /// Accessibility role when the match came from the AX tree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

// ──────────────────────────────────────────────────────────────────────────────
// AX snapshot node (cross-platform shape)
// ──────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AXNode {
    pub uid: String,
    pub role: String,
    pub label: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub bounds: Option<Rect>,
    pub enabled: Option<bool>,
    pub focused: Option<bool>,
    pub children: Vec<AXNode>,
}
