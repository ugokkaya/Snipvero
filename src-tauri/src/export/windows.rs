//! Windows clipboard through `arboard`, which writes CF_DIBV5 plus a registered "PNG" format.
//! Compile- and CI-tested only: Windows capture is not implemented yet (ADR-008, ADR-018).

use std::borrow::Cow;

use super::Image;

pub fn copy_image(image: &Image) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: image.width as usize,
            height: image.height as usize,
            bytes: Cow::Borrowed(&image.rgba),
        })
        .map_err(|e| e.to_string())
}
