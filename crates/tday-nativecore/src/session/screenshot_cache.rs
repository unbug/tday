// Copyright (c) 2024-2026 Tday Authors. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1
// See LICENSE in the repository root for full license text.

/// LRU screenshot cache for find_image and coordinate re-use.

use std::collections::{HashMap, VecDeque};

const MAX_ENTRIES: usize = 10;

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ScreenshotMeta {
    pub origin_x:     f64,
    pub origin_y:     f64,
    pub scale:        f64,
    pub window_id:    Option<u32>,
    pub pixel_width:  u32,
    pub pixel_height: u32,
}

#[derive(Clone)]
pub struct CachedScreenshot {
    pub id:       String,
    pub png_data: Vec<u8>,
    pub metadata: ScreenshotMeta,
}

#[derive(Default)]
pub struct ScreenshotCache {
    entries: VecDeque<CachedScreenshot>,
    index:   HashMap<String, usize>, // id → position in entries
    counter: u64,
}

impl ScreenshotCache {
    /// Store a screenshot and return its generated ID.
    pub fn store(&mut self, png_data: Vec<u8>, meta: ScreenshotMeta) -> String {
        self.counter += 1;
        let id = format!("ss_{}", self.counter);
        if self.entries.len() >= MAX_ENTRIES {
            if let Some(front) = self.entries.pop_front() {
                self.index.remove(&front.id);
                // Shift all indices down by 1
                for v in self.index.values_mut() { *v -= 1; }
            }
        }
        self.index.insert(id.clone(), self.entries.len());
        self.entries.push_back(CachedScreenshot { id: id.clone(), png_data, metadata: meta });
        id
    }

    /// Peek (no LRU bump) — used by find_image which clones the data immediately.
    pub fn peek(&self, id: &str) -> Option<&CachedScreenshot> {
        let pos = self.index.get(id)?;
        self.entries.get(*pos)
    }
}
