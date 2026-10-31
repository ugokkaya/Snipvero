//! Pure coordinate math shared by capture and overlay code.
//!
//! Desktop coordinates are logical (macOS points), y-down, with the origin at the top-left of the
//! primary display. Displays left of or above the primary display have negative coordinates.
//! Selections are frame-local physical pixels (`PixelRect`), mirroring `src/overlay/coords.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LogicalRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl LogicalRect {
    /// Half-open containment, so a point on a shared edge belongs to exactly one display.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }

    /// Bottom edge in Cocoa coordinates (y-up from the bottom of the primary display).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn cocoa_y(&self, primary_height: f64) -> f64 {
        primary_height - self.y - self.height
    }
}

/// A region of one captured frame in physical pixels, with the origin at the frame's top-left.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl PixelRect {
    /// Non-empty and entirely inside a `width`×`height` frame.
    pub fn fits(&self, width: u32, height: u32) -> bool {
        self.width > 0
            && self.height > 0
            && self.x.checked_add(self.width).is_some_and(|r| r <= width)
            && self.y.checked_add(self.height).is_some_and(|b| b <= height)
    }

    /// The region in desktop logical coordinates, for a frame of `frame` pixels covering `bounds`.
    /// Uses the per-axis frame/bounds ratio, as the overlay does, rather than a rounded scale.
    pub fn to_logical(self, bounds: LogicalRect, frame: (u32, u32)) -> LogicalRect {
        let sx = f64::from(frame.0) / bounds.width;
        let sy = f64::from(frame.1) / bounds.height;
        LogicalRect {
            x: bounds.x + f64::from(self.x) / sx,
            y: bounds.y + f64::from(self.y) / sy,
            width: f64::from(self.width) / sx,
            height: f64::from(self.height) / sy,
        }
    }
}

/// Pixel size of a logical size at `scale`. Rounds to absorb float error from fractional scales
/// (for example 1706.67 pt × 1.5 = 2560 px).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn physical_size(width: f64, height: f64, scale: f64) -> (u32, u32) {
    (
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUILT_IN: LogicalRect = LogicalRect {
        x: 0.0,
        y: 0.0,
        width: 1512.0,
        height: 982.0,
    };
    const LEFT: LogicalRect = LogicalRect {
        x: -1920.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    #[test]
    fn retina_and_standard_sizes() {
        assert_eq!(physical_size(1512.0, 982.0, 2.0), (3024, 1964));
        assert_eq!(physical_size(1920.0, 1080.0, 1.0), (1920, 1080));
    }

    #[test]
    fn fractional_scale_rounds() {
        assert_eq!(physical_size(2560.0 / 1.5, 1440.0 / 1.5, 1.5), (2560, 1440));
        assert_eq!(physical_size(2048.0, 1152.0, 1.25), (2560, 1440));
    }

    #[test]
    fn negative_coordinates_and_shared_edges() {
        assert!(LEFT.contains(-1.0, 500.0));
        assert!(!LEFT.contains(0.0, 500.0));
        assert!(BUILT_IN.contains(0.0, 500.0));
        assert!(!BUILT_IN.contains(1512.0, 0.0));
    }

    #[test]
    fn pixel_rect_must_be_non_empty_and_inside_the_frame() {
        let rect = |x, y, width, height| PixelRect {
            x,
            y,
            width,
            height,
        };
        assert!(rect(0, 0, 3024, 1964).fits(3024, 1964));
        assert!(rect(3023, 1963, 1, 1).fits(3024, 1964));
        assert!(!rect(3023, 0, 2, 1).fits(3024, 1964));
        assert!(!rect(0, 0, 0, 10).fits(3024, 1964));
        assert!(!rect(0, 0, 10, 0).fits(3024, 1964));
        assert!(!rect(u32::MAX, 0, 1, 1).fits(3024, 1964));
    }

    #[test]
    fn pixel_rect_to_logical_on_retina_and_negative_displays() {
        let region = PixelRect {
            x: 200,
            y: 100,
            width: 400,
            height: 300,
        };
        let retina = region.to_logical(BUILT_IN, (3024, 1964));
        assert_eq!(
            retina,
            LogicalRect {
                x: 100.0,
                y: 50.0,
                width: 200.0,
                height: 150.0
            }
        );
        let left = region.to_logical(LEFT, (1920, 1080));
        assert_eq!(
            left,
            LogicalRect {
                x: -1720.0,
                y: 100.0,
                width: 400.0,
                height: 300.0
            }
        );
    }

    #[test]
    fn cocoa_y_flips_relative_to_primary() {
        assert_eq!(BUILT_IN.cocoa_y(982.0), 0.0);
        // A 1080-pt display top-aligned with a 982-pt primary extends 98 pt below it.
        assert_eq!(LEFT.cocoa_y(982.0), -98.0);
    }
}
