use crate::app_protocol::messages::{ProtocolError, ProtocolRequest, ProtocolResponse};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

#[derive(Error, Debug)]
pub enum ClientError {
    #[error("Failed to parse URL: {0}")]
    UrlParseError(#[from] url::ParseError),

    #[error("Invalid URL scheme: expected 'ws' or 'wss', got '{0}'")]
    InvalidScheme(String),

    #[error("WebSocket connection failed: {0}")]
    ConnectionError(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("Failed to send message")]
    SendError,

    #[error("Failed to receive response")]
    ReceiveError,

    #[error("Request timed out after {0} seconds")]
    Timeout(u64),

    #[error("JSON serialization error: {0}")]
    JsonError(#[from] serde_json::Error),

    #[error("Protocol error {code}: {message}")]
    Protocol { code: i32, message: String },
}

impl From<ProtocolError> for ClientError {
    fn from(err: ProtocolError) -> Self {
        ClientError::Protocol {
            code: err.code,
            message: err.message,
        }
    }
}

type PendingRequests = Arc<Mutex<HashMap<u64, oneshot::Sender<ProtocolResponse>>>>;

/// Default timeout for requests in seconds
const DEFAULT_REQUEST_TIMEOUT_SECS: u64 = 30;

/// WebSocket client for connecting to app's debug server
#[derive(Clone)]
pub struct AppProtocolClient {
    sender: mpsc::Sender<Message>,
    pending: PendingRequests,
    next_id: Arc<AtomicU64>,
    request_timeout: Duration,
    /// Shutdown signal sender — when dropped or sent, tasks will terminate
    shutdown: Arc<tokio::sync::watch::Sender<bool>>,
}

impl AppProtocolClient {
    /// Connect to an app's debug server
    pub async fn connect(url_str: &str) -> Result<Self, ClientError> {
        // Validate URL format and scheme
        let url = Url::parse(url_str)?;
        match url.scheme() {
            "ws" | "wss" => {}
            scheme => return Err(ClientError::InvalidScheme(scheme.to_string())),
        }
        let (ws_stream, _) = connect_async(url_str).await?;
        let (mut write, mut read) = ws_stream.split();

        let (tx, mut rx) = mpsc::channel::<Message>(32);
        let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
        let (shutdown_tx, mut shutdown_rx1) = tokio::sync::watch::channel(false);
        let mut shutdown_rx2 = shutdown_tx.subscribe();

        // Spawn writer task
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = rx.recv() => {
                        match msg {
                            Some(msg) => {
                                if write.send(msg).await.is_err() {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                    _ = shutdown_rx1.changed() => {
                        let _ = write.send(Message::Close(None)).await;
                        break;
                    }
                }
            }
        });

        // Spawn reader task
        let pending_clone = pending.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg_result = read.next() => {
                        match msg_result {
                            Some(Ok(Message::Text(text))) => {
                                if let Ok(response) = serde_json::from_str::<ProtocolResponse>(&text) {
                                    let mut pending = pending_clone.lock().await;
                                    if let Some(sender) = pending.remove(&response.id) {
                                        let _ = sender.send(response);
                                    }
                                }
                            }
                            Some(Ok(_)) => {}
                            Some(Err(_)) | None => break,
                        }
                    }
                    _ = shutdown_rx2.changed() => {
                        break;
                    }
                }
            }
        });

        Ok(Self {
            sender: tx,
            pending,
            next_id: Arc::new(AtomicU64::new(1)),
            request_timeout: Duration::from_secs(DEFAULT_REQUEST_TIMEOUT_SECS),
            shutdown: Arc::new(shutdown_tx),
        })
    }

    /// Close the connection, signalling background tasks to shut down.
    pub fn close(&self) {
        let _ = self.shutdown.send(true);
    }

    /// Call a method on the app's debug server
    pub async fn call(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, ClientError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = ProtocolRequest {
            id,
            method: method.to_string(),
            params,
        };

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let msg = Message::Text(serde_json::to_string(&request)?);
        if self.sender.send(msg).await.is_err() {
            self.pending.lock().await.remove(&id);
            return Err(ClientError::SendError);
        }

        let timeout_secs = self.request_timeout.as_secs();
        match timeout(self.request_timeout, rx).await {
            Ok(Ok(response)) => {
                if let Some(error) = response.error {
                    return Err(error.into());
                }
                Ok(response.result.unwrap_or(serde_json::Value::Null))
            }
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                Err(ClientError::ReceiveError)
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(ClientError::Timeout(timeout_secs))
            }
        }
    }

    // MARK: - Convenience Methods

    /// Get runtime info from the app
    pub async fn get_runtime_info(&self) -> Result<serde_json::Value, ClientError> {
        self.call("Runtime.getInfo", None).await
    }

    /// Get the view tree
    pub async fn get_tree(
        &self,
        depth: Option<i32>,
        root_id: Option<&str>,
    ) -> Result<serde_json::Value, ClientError> {
        let params = serde_json::json!({
            "depth": depth,
            "rootId": root_id
        });
        self.call("View.getTree", Some(params)).await
    }

    /// Query for an element
    pub async fn query_selector(&self, selector: &str) -> Result<serde_json::Value, ClientError> {
        self.call(
            "View.querySelector",
            Some(serde_json::json!({ "selector": selector })),
        )
        .await
    }

    /// Query for all matching elements
    pub async fn query_selector_all(
        &self,
        selector: &str,
    ) -> Result<serde_json::Value, ClientError> {
        self.call(
            "View.querySelectorAll",
            Some(serde_json::json!({ "selector": selector })),
        )
        .await
    }

    /// Get element details
    pub async fn get_element(&self, element_id: &str) -> Result<serde_json::Value, ClientError> {
        self.call(
            "View.getElement",
            Some(serde_json::json!({ "elementId": element_id })),
        )
        .await
    }

    /// Take a screenshot
    pub async fn get_screenshot(
        &self,
        element_id: Option<&str>,
    ) -> Result<serde_json::Value, ClientError> {
        let params = element_id.map(|id| serde_json::json!({ "elementId": id }));
        self.call("View.getScreenshot", params).await
    }

    /// Click an element
    pub async fn click(
        &self,
        element_id: &str,
        click_count: Option<i32>,
    ) -> Result<serde_json::Value, ClientError> {
        let params = serde_json::json!({
            "elementId": element_id,
            "clickCount": click_count
        });
        self.call("Input.click", Some(params)).await
    }

    /// Type text
    pub async fn type_text(
        &self,
        text: &str,
        element_id: Option<&str>,
        clear_first: bool,
    ) -> Result<serde_json::Value, ClientError> {
        let params = serde_json::json!({
            "text": text,
            "elementId": element_id,
            "clearFirst": clear_first
        });
        self.call("Input.type", Some(params)).await
    }

    /// Press a key
    pub async fn press_key(
        &self,
        key: &str,
        modifiers: Vec<String>,
    ) -> Result<serde_json::Value, ClientError> {
        self.call(
            "Input.pressKey",
            Some(serde_json::json!({ "key": key, "modifiers": modifiers })),
        )
        .await
    }

    /// Focus an element
    pub async fn focus(&self, element_id: &str) -> Result<serde_json::Value, ClientError> {
        self.call(
            "Input.focus",
            Some(serde_json::json!({ "elementId": element_id })),
        )
        .await
    }

    /// List windows
    pub async fn list_windows(&self) -> Result<serde_json::Value, ClientError> {
        self.call("Window.list", None).await
    }

    /// Focus a window (make it key and main)
    pub async fn focus_window(&self, window_id: &str) -> Result<serde_json::Value, ClientError> {
        self.call(
            "Window.focus",
            Some(serde_json::json!({ "windowId": window_id })),
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_error_invalid_scheme() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(AppProtocolClient::connect("http://localhost:9229"));
        assert!(matches!(result, Err(ClientError::InvalidScheme(_))));
    }

    #[test]
    fn client_error_invalid_url() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(AppProtocolClient::connect("not-a-url"));
        assert!(matches!(result, Err(ClientError::UrlParseError(_))));
    }
}
