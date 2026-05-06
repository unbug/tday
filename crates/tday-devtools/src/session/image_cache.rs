/// LRU image cache for find_image template images (load_image tool).

use std::collections::VecDeque;

const MAX_ENTRIES: usize = 20;

#[derive(Clone)]
pub struct CachedImage {
    pub id:       String,
    pub png_data: Vec<u8>,
}

#[derive(Default)]
pub struct ImageCache {
    entries: VecDeque<CachedImage>,
    counter: u64,
}

impl ImageCache {
    /// Store an image and return its generated ID.
    pub fn store(&mut self, png_data: Vec<u8>) -> String {
        self.counter += 1;
        let id = format!("img_{}", self.counter);
        if self.entries.len() >= MAX_ENTRIES {
            self.entries.pop_front();
        }
        self.entries.push_back(CachedImage { id: id.clone(), png_data });
        id
    }

    /// Get (LRU bump via move-to-back).
    pub fn get(&mut self, id: &str) -> Option<CachedImage> {
        if let Some(pos) = self.entries.iter().position(|e| e.id == id) {
            let entry = self.entries.remove(pos)?;
            let cloned = entry.clone();
            self.entries.push_back(entry);
            Some(cloned)
        } else {
            None
        }
    }
}
