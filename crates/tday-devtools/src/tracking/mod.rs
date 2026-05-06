pub mod hover_tracker;
pub mod screen_recorder;

pub use hover_tracker::{HoverTracker, start_polling};
pub use screen_recorder::{ScreenRecorder, start_recording};
