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

/// Local logical rectangles for the delayed-capture border and badge. The badge prefers the
/// space above the selection, but must stay visible even at an edge or on a tiny selection.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn countdown_layout(
    region: PixelRect,
    bounds: LogicalRect,
    frame: (u32, u32),
) -> (LogicalRect, LogicalRect) {
    let desktop = region.to_logical(bounds, frame);
    let border = LogicalRect {
        x: desktop.x - bounds.x,
        y: desktop.y - bounds.y,
        ..desktop
    };
    let width = 112.0_f64.min(bounds.width);
    let height = 28.0_f64.min(bounds.height);
    let y = if border.y >= height + 6.0 {
        border.y - height - 6.0
    } else if border.y + border.height + 6.0 + height <= bounds.height {
        border.y + border.height + 6.0
    } else {
        border.y
    };
    let badge = LogicalRect {
        x: border.x.clamp(0.0, bounds.width - width),
        y: y.clamp(0.0, bounds.height - height),
        width,
        height,
    };
    (border, badge)
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

/// Smallest side of a recording, in output pixels (hardware H.264 encoders refuse tiny frames).
pub const MIN_RECORDING_SIDE: u32 = 16;
/// Largest side of a recording. With `MAX_RECORDING_PIXELS` this keeps the frame inside H.264
/// level 5.2 (36 864 macroblocks), which the hardware encoder accepts at the 30 fps used.
pub const MAX_RECORDING_SIDE: u32 = 8192;
pub const MAX_RECORDING_PIXELS: u64 = 36_864 * 256;
/// Fixed frame rate of a recording (ADR-037: no 60 fps option in the first version).
pub const RECORDING_FPS: u32 = 30;
/// Bits per pixel per frame the bitrate is derived from, and its limits in bit/s (ADR-037).
const BITS_PER_PIXEL: f64 = 0.1;
const MIN_BITRATE: u32 = 2_000_000;
const MAX_BITRATE: u32 = 20_000_000;

/// Why a region cannot be recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegionError {
    /// Empty or outside the frame, so not a region of this display at all.
    Outside,
    /// Below `MIN_RECORDING_SIDE` once rounded to even numbers.
    TooSmall,
    /// Beyond what H.264 level 5.2 can encode.
    TooLarge,
}

/// The recorded rectangle of a display: what the stream is asked for, and the output size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecordingGeometry {
    /// Display-local points (origin at the display's top-left): `SCStreamConfiguration.sourceRect`.
    pub source: LogicalRect,
    /// Output size in pixels; both even, as H.264 4:2:0 requires.
    pub width: u32,
    pub height: u32,
}

/// Rounds a pixel size down to even numbers.
pub fn even_output_size(width: u32, height: u32) -> (u32, u32) {
    (width & !1, height & !1)
}

/// A frame-pixel region in display-local points. Uses the per-axis frame/bounds ratio, as
/// `PixelRect::to_logical` does, so mixed-DPI and fractional scales stay exact.
pub fn region_to_points(region: PixelRect, bounds: LogicalRect, frame: (u32, u32)) -> LogicalRect {
    let desktop = region.to_logical(bounds, frame);
    LogicalRect {
        x: desktop.x - bounds.x,
        y: desktop.y - bounds.y,
        ..desktop
    }
}

/// The geometry of a recording of `region` (frame pixels of a display of `bounds` points). The
/// region is cut down to even numbers first and the source rectangle follows the cut one, so the
/// stream is never asked to scale by a pixel.
pub fn recording_geometry(
    region: PixelRect,
    bounds: LogicalRect,
    frame: (u32, u32),
) -> Result<RecordingGeometry, RegionError> {
    if !region.fits(frame.0, frame.1) {
        return Err(RegionError::Outside);
    }
    let (width, height) = even_output_size(region.width, region.height);
    if width < MIN_RECORDING_SIDE || height < MIN_RECORDING_SIDE {
        return Err(RegionError::TooSmall);
    }
    if width > MAX_RECORDING_SIDE
        || height > MAX_RECORDING_SIDE
        || u64::from(width) * u64::from(height) > MAX_RECORDING_PIXELS
    {
        return Err(RegionError::TooLarge);
    }
    let cut = PixelRect {
        width,
        height,
        ..region
    };
    Ok(RecordingGeometry {
        source: region_to_points(cut, bounds, frame),
        width,
        height,
    })
}

/// Video bitrate in bit/s: about 0.1 bit per pixel per frame, between 2 and 20 Mbit/s. Together
/// with the duration cap this bounds the file size by construction (ADR-037).
pub fn recording_bitrate(width: u32, height: u32, fps: u32) -> u32 {
    let wanted = f64::from(width) * f64::from(height) * f64::from(fps) * BITS_PER_PIXEL;
    wanted.clamp(f64::from(MIN_BITRATE), f64::from(MAX_BITRATE)) as u32
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

    #[test]
    fn countdown_tracks_frame_pixels_on_retina_and_negative_displays() {
        let region = PixelRect {
            x: 200,
            y: 100,
            width: 400,
            height: 300,
        };
        let (border, badge) = countdown_layout(region, BUILT_IN, (3024, 1964));
        assert_eq!(
            border,
            LogicalRect {
                x: 100.0,
                y: 50.0,
                width: 200.0,
                height: 150.0
            }
        );
        assert_eq!((badge.x, badge.y), (100.0, 16.0));
        let (border, badge) = countdown_layout(region, LEFT, (1920, 1080));
        assert_eq!((border.x, border.y, border.width), (200.0, 100.0, 400.0));
        assert_eq!((badge.x, badge.y), (200.0, 66.0));
    }

    #[test]
    fn countdown_badge_stays_on_screen_at_edges_and_for_fullscreen_regions() {
        for region in [
            PixelRect {
                x: 3023,
                y: 0,
                width: 1,
                height: 1,
            },
            PixelRect {
                x: 0,
                y: 0,
                width: 3024,
                height: 1964,
            },
            PixelRect {
                x: 3023,
                y: 1963,
                width: 1,
                height: 1,
            },
        ] {
            let (_, badge) = countdown_layout(region, BUILT_IN, (3024, 1964));
            assert!(badge.x >= 0.0 && badge.y >= 0.0);
            assert!(badge.x + badge.width <= BUILT_IN.width);
            assert!(badge.y + badge.height <= BUILT_IN.height);
        }
        let tiny = LogicalRect {
            x: -10.0,
            y: -10.0,
            width: 20.0,
            height: 20.0,
        };
        let (_, badge) = countdown_layout(
            PixelRect {
                x: 0,
                y: 0,
                width: 20,
                height: 20,
            },
            tiny,
            (20, 20),
        );
        assert_eq!(
            badge,
            LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0
            }
        );
    }

    const fn pixels(x: u32, y: u32, width: u32, height: u32) -> PixelRect {
        PixelRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn output_sizes_round_down_to_even() {
        assert_eq!(even_output_size(1920, 1080), (1920, 1080));
        assert_eq!(even_output_size(1921, 1081), (1920, 1080));
        assert_eq!(even_output_size(17, 31), (16, 30));
        assert_eq!(even_output_size(1, 0), (0, 0));
    }

    #[test]
    fn region_points_are_display_local_on_retina_and_negative_displays() {
        let region = pixels(200, 100, 400, 300);
        assert_eq!(
            region_to_points(region, BUILT_IN, (3024, 1964)),
            LogicalRect {
                x: 100.0,
                y: 50.0,
                width: 200.0,
                height: 150.0
            }
        );
        // A display left of the primary one has negative desktop coordinates, but the stream's
        // source rectangle is relative to the display itself.
        assert_eq!(
            region_to_points(region, LEFT, (1920, 1080)),
            LogicalRect {
                x: 200.0,
                y: 100.0,
                width: 400.0,
                height: 300.0
            }
        );
    }

    #[test]
    fn region_points_follow_a_fractional_scale() {
        // 2560×1440 px shown as 1706.67×960 pt (1.5×): the per-axis ratio keeps the right edge exact.
        let scaled = LogicalRect {
            x: 0.0,
            y: 0.0,
            width: 2560.0 / 1.5,
            height: 960.0,
        };
        let points = region_to_points(pixels(1280, 0, 1280, 1440), scaled, (2560, 1440));
        assert!((points.x - 1280.0 / 1.5).abs() < 1e-9);
        assert!((points.x + points.width - scaled.width).abs() < 1e-9);
        assert!((points.height - 960.0).abs() < 1e-9);
    }

    #[test]
    fn odd_regions_are_cut_and_the_source_rectangle_follows() {
        let geometry = recording_geometry(pixels(201, 101, 401, 301), BUILT_IN, (3024, 1964))
            .expect("valid region");
        assert_eq!((geometry.width, geometry.height), (400, 300));
        // The cut region starts where the selection starts and is exactly 200×150 pt, so the
        // stream does not scale the odd pixel away.
        assert_eq!(
            geometry.source,
            LogicalRect {
                x: 100.5,
                y: 50.5,
                width: 200.0,
                height: 150.0
            }
        );
    }

    #[test]
    fn mixed_dpi_displays_give_the_same_pixel_size_for_each_scale() {
        // The same 640×480 pixel selection on the 1× and the 2× display is 640×480 and 320×240 pt.
        let on_standard = recording_geometry(pixels(0, 0, 640, 480), LEFT, (1920, 1080)).unwrap();
        let on_retina = recording_geometry(pixels(0, 0, 640, 480), BUILT_IN, (3024, 1964)).unwrap();
        assert_eq!((on_standard.width, on_standard.height), (640, 480));
        assert_eq!((on_retina.width, on_retina.height), (640, 480));
        assert_eq!(on_standard.source.width, 640.0);
        assert_eq!(on_retina.source.width, 320.0);
    }

    #[test]
    fn recording_geometry_refuses_unusable_regions() {
        let frame = (3024, 1964);
        assert_eq!(
            recording_geometry(pixels(3000, 0, 100, 100), BUILT_IN, frame),
            Err(RegionError::Outside)
        );
        assert_eq!(
            recording_geometry(pixels(0, 0, 0, 100), BUILT_IN, frame),
            Err(RegionError::Outside)
        );
        // 15 px is below the minimum; 17 px is cut to 16, which is accepted.
        assert_eq!(
            recording_geometry(pixels(0, 0, 15, 100), BUILT_IN, frame),
            Err(RegionError::TooSmall)
        );
        assert_eq!(
            recording_geometry(pixels(0, 0, 100, 17), BUILT_IN, frame).map(|g| (g.width, g.height)),
            Ok((100, 16))
        );
        // A 5K display's full frame is beyond H.264 level 5.2; a 4K one is within it.
        let five_k = LogicalRect {
            x: 0.0,
            y: 0.0,
            width: 2560.0,
            height: 1440.0,
        };
        assert_eq!(
            recording_geometry(pixels(0, 0, 5120, 2880), five_k, (5120, 2880)),
            Err(RegionError::TooLarge)
        );
        assert_eq!(
            recording_geometry(pixels(0, 0, 3840, 2160), five_k, (5120, 2880))
                .map(|g| (g.width, g.height)),
            Ok((3840, 2160))
        );
        let wide = LogicalRect {
            x: 0.0,
            y: 0.0,
            width: 9000.0,
            height: 100.0,
        };
        assert_eq!(
            recording_geometry(pixels(0, 0, 8194, 100), wide, (9000, 100)),
            Err(RegionError::TooLarge)
        );
    }

    #[test]
    fn bitrate_follows_the_pixel_rate_within_its_limits() {
        // 1080p30 at 0.1 bit per pixel per frame is about 6.2 Mbit/s.
        assert_eq!(recording_bitrate(1920, 1080, 30), 6_220_800);
        // Tiny regions still get a usable floor; large ones are capped, so size is bounded.
        assert_eq!(recording_bitrate(16, 16, 30), 2_000_000);
        assert_eq!(recording_bitrate(3840, 2160, 30), 20_000_000);
        assert_eq!(recording_bitrate(8192, 1152, 30), 20_000_000);
    }
}
