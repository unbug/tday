use thiserror::Error;

#[derive(Debug, Error)]
pub enum DevToolsError {
    #[error("screenshot: {0}")]
    Screenshot(String),

    #[error("OCR: {0}")]
    Ocr(String),

    #[error("input: {0}")]
    Input(String),

    #[error("window not found: {0}")]
    WindowNotFound(u32),

    #[error("app not found: {0}")]
    AppNotFound(String),

    #[error("accessibility: {0}")]
    Accessibility(String),

    #[error("image: {0}")]
    Image(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

impl From<String> for DevToolsError {
    fn from(s: String) -> Self {
        DevToolsError::Other(s)
    }
}

impl From<&str> for DevToolsError {
    fn from(s: &str) -> Self {
        DevToolsError::Other(s.to_owned())
    }
}

pub type Result<T> = std::result::Result<T, DevToolsError>;
