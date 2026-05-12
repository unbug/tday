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

/// Cache: `map` provides O(1) lookup by id; `order` tracks eviction order.
pub struct ScreenshotCache {
    map:     HashMap<String, CachedScreenshot>,
    order:   VecDeque<String>,
    counter: u64,
}

impl Default for ScreenshotCache {
    fn default() -> Self {
        Self { map: HashMap::new(), order: VecDeque::new(), counter: 0 }
    }
}

impl ScreenshotCache {
    /// Store a screenshot and return its generated ID.
    pub fn store(&mut self, png_data: Vec<u8>, meta: ScreenshotMeta) -> String {
        self.counter += 1;
        let id = format!("ss_{}", self.counter);
        if self.map.len() >= MAX_ENTRIES {
            if let Some(evicted) = self.order.pop_front() {
                self.map.remove(&evicted);
            }
        }
        self.order.push_back(id.clone());
        self.map.insert(id.clone(), CachedScreenshot { id: id.clone(), png_data, metadata: meta });
        id
    }

    /// Peek (no LRU bump) — O(1) via HashMap.
    pub fn peek(&self, id: &str) -> Option<&CachedScreenshot> {
        self.map.get(id)
    }
}
