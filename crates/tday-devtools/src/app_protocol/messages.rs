use serde::{Deserialize, Serialize};

/// Request sent to app's debug server
#[derive(Debug, Clone, Serialize)]
pub struct ProtocolRequest {
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// Response from app's debug server
#[derive(Debug, Clone, Deserialize)]
pub struct ProtocolResponse {
    pub id: u64,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<ProtocolError>,
}

/// Error in protocol response
#[derive(Debug, Clone, Deserialize)]
pub struct ProtocolError {
    pub code: i32,
    pub message: String,
}
