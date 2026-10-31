//! Moving a captured frame into the webview: raw RGBA bytes over Tauri IPC (ADR-007).

use crate::capture::Frame;

/// RGBA8 copy of the frame, ready for `ImageData` in the webview.
pub fn to_rgba(frame: &Frame) -> Vec<u8> {
    let mut rgba = frame.bgra.clone();
    for px in rgba.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
    }
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::LogicalRect;

    #[test]
    fn swaps_red_and_blue() {
        let frame = Frame {
            display_id: 1,
            bounds: LogicalRect {
                x: 0.0,
                y: 0.0,
                width: 2.0,
                height: 1.0,
            },
            scale: 1.0,
            width: 2,
            height: 1,
            // A blue pixel then a red pixel, stored as BGRA.
            bgra: vec![255, 0, 0, 255, 0, 0, 255, 255],
        };
        assert_eq!(to_rgba(&frame), vec![0, 0, 255, 255, 255, 0, 0, 255]);
    }
}
