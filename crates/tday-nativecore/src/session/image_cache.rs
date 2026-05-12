// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

/// LRU image cache for find_image template images (load_image tool).

use std::collections::{HashMap, VecDeque};

const MAX_ENTRIES: usize = 20;

#[derive(Clone)]
pub struct CachedImage {
    pub id:       String,
    pub png_data: Vec<u8>,
}

/// LRU cache: `map` provides O(1) lookup by id; `order` is a VecDeque of ids
/// in insertion/access order (front = oldest, back = newest).
pub struct ImageCache {
    map:     HashMap<String, Vec<u8>>,
    order:   VecDeque<String>,
    counter: u64,
}

impl Default for ImageCache {
    fn default() -> Self {
        Self { map: HashMap::new(), order: VecDeque::new(), counter: 0 }
    }
}

impl ImageCache {
    /// Store an image and return its generated ID.
    pub fn store(&mut self, png_data: Vec<u8>) -> String {
        self.counter += 1;
        let id = format!("img_{}", self.counter);
        if self.map.len() >= MAX_ENTRIES {
            if let Some(evicted) = self.order.pop_front() {
                self.map.remove(&evicted);
            }
        }
        self.map.insert(id.clone(), png_data);
        self.order.push_back(id.clone());
        id
    }

    /// Get with LRU bump (move to back of order queue).
    pub fn get(&mut self, id: &str) -> Option<CachedImage> {
        let png_data = self.map.get(id)?.clone();
        // Move to back: remove from current position (O(n)) and push to back.
        if let Some(pos) = self.order.iter().position(|k| k == id) {
            self.order.remove(pos);
        }
        self.order.push_back(id.to_string());
        Some(CachedImage { id: id.to_string(), png_data })
    }
}
