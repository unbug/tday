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

#[derive(Default)]
pub struct ImageCache {
    entries: VecDeque<CachedImage>,
    index:   HashMap<String, usize>, // id → position in entries
    counter: u64,
}

impl ImageCache {
    /// Store an image and return its generated ID.
    pub fn store(&mut self, png_data: Vec<u8>) -> String {
        self.counter += 1;
        let id = format!("img_{}", self.counter);
        if self.entries.len() >= MAX_ENTRIES {
            if let Some(front) = self.entries.pop_front() {
                self.index.remove(&front.id);
                // Shift all indices down by 1
                for v in self.index.values_mut() { *v -= 1; }
            }
        }
        self.index.insert(id.clone(), self.entries.len());
        self.entries.push_back(CachedImage { id: id.clone(), png_data });
        id
    }

    /// Get (LRU bump via move-to-back).
    pub fn get(&mut self, id: &str) -> Option<CachedImage> {
        let pos = *self.index.get(id)?;
        let entry = self.entries.remove(pos)?;
        let cloned = entry.clone();
        // Shift all indices that were after `pos` down by 1
        for v in self.index.values_mut() {
            if *v > pos { *v -= 1; }
        }
        // Move to back
        let new_pos = self.entries.len();
        self.index.insert(entry.id.clone(), new_pos);
        self.entries.push_back(entry);
        Some(cloned)
    }
}
