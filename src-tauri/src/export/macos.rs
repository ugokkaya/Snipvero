//! macOS clipboard: one pasteboard item with PNG and TIFF data, through AppKit directly.
//! PNG is what current apps read first; TIFF is the classic image type older apps expect.

use objc2::msg_send;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{
    NSBitmapImageRep, NSPasteboard, NSPasteboardItem, NSPasteboardTypePNG, NSPasteboardTypeTIFF,
};
use objc2_foundation::{NSArray, NSData};

use super::{Image, encode_png};

pub fn copy_image(image: &Image) -> Result<(), String> {
    copy_image_to(&NSPasteboard::generalPasteboard(), image)
}

/// The whole clipboard path on a private pasteboard that no other app reads, released afterwards:
/// for tests and the `--stress-export` harness, which must not replace the user's clipboard.
/// Returns the PNG and TIFF sizes found on it.
pub fn copy_image_isolated(image: &Image) -> Result<(usize, usize), String> {
    autoreleasepool(|_| {
        let pasteboard = PrivatePasteboard(NSPasteboard::pasteboardWithUniqueName());
        copy_image_to(&pasteboard.0, image)?;
        // SAFETY: immutable AppKit constants.
        let (png_type, tiff_type) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
        let png = pasteboard
            .0
            .dataForType(png_type)
            .ok_or("no PNG on the pasteboard")?;
        let tiff = pasteboard
            .0
            .dataForType(tiff_type)
            .ok_or("no TIFF on the pasteboard")?;
        Ok((png.length(), tiff.length()))
    })
}

/// Releases the pasteboard server's copy of a unique pasteboard when dropped.
struct PrivatePasteboard(Retained<NSPasteboard>);

impl Drop for PrivatePasteboard {
    fn drop(&mut self) {
        // SAFETY: `releaseGlobally` takes no arguments and returns nothing; objc2-app-kit 0.3
        // does not bind it.
        let () = unsafe { msg_send![&*self.0, releaseGlobally] };
    }
}

fn copy_image_to(pasteboard: &NSPasteboard, image: &Image) -> Result<(), String> {
    // AppKit autoreleases the image rep and its temporaries. Exports run on long-lived async
    // runtime threads without a pool of their own, where these objects (several MB per copy)
    // were only released when the thread exited, i.e. never (measured in stress runs).
    autoreleasepool(|_| write_image(pasteboard, image))
}

fn write_image(pasteboard: &NSPasteboard, image: &Image) -> Result<(), String> {
    let png = NSData::with_bytes(&encode_png(image, png::Compression::Fast)?);
    let tiff = NSBitmapImageRep::imageRepWithData(&png)
        .and_then(|rep| rep.TIFFRepresentation())
        .ok_or("could not convert the image for the clipboard")?;
    let item = NSPasteboardItem::new();
    // SAFETY: AppKit's pasteboard type constants are immutable NSString statics.
    let (png_type, tiff_type) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
    if !item.setData_forType(&png, png_type) || !item.setData_forType(&tiff, tiff_type) {
        return Err("could not prepare the clipboard item".into());
    }
    pasteboard.clearContents();
    let items = NSArray::from_retained_slice(&[ProtocolObject::from_retained(item)]);
    if pasteboard.writeObjects(&items) {
        Ok(())
    } else {
        Err("the clipboard rejected the image".into())
    }
}

#[cfg(test)]
mod tests {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF};

    use super::{PrivatePasteboard, copy_image, copy_image_to};
    use crate::export::Image;

    fn image() -> Image {
        // An odd size and two colours, so a scaled or swapped image would not decode the same.
        let mut rgba = [12, 34, 56, 255].repeat(301 * 157);
        rgba[..4].copy_from_slice(&[250, 10, 20, 255]);
        Image {
            width: 301,
            height: 157,
            rgba,
        }
    }

    /// The PNG on `pasteboard` decodes to exactly `image`; TIFF is present too.
    fn assert_holds(pasteboard: &NSPasteboard, image: &Image) {
        // SAFETY: immutable AppKit constants.
        let (png_type, tiff_type) = unsafe { (NSPasteboardTypePNG, NSPasteboardTypeTIFF) };
        assert!(pasteboard.dataForType(tiff_type).is_some());
        let png = pasteboard.dataForType(png_type).unwrap().to_vec();
        let mut reader = png::Decoder::new(std::io::Cursor::new(png))
            .read_info()
            .unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (image.width, image.height));
        assert_eq!(&buf[..info.buffer_size()], &image.rgba[..]);
    }

    /// Uses a private pasteboard, so it never touches the user's clipboard.
    #[test]
    fn private_pasteboard_holds_the_exact_png_and_a_tiff() {
        let image = image();
        let pasteboard = PrivatePasteboard(NSPasteboard::pasteboardWithUniqueName());
        copy_image_to(&pasteboard.0, &image).unwrap();
        assert_holds(&pasteboard.0, &image);
    }

    /// Replaces the real clipboard, so it only runs on request:
    /// `cargo test -- --ignored clipboard`.
    #[test]
    #[ignore = "overwrites the system clipboard"]
    fn clipboard_holds_a_png_and_tiff_of_the_image_size() {
        let image = image();
        copy_image(&image).unwrap();
        assert_holds(&NSPasteboard::generalPasteboard(), &image);
    }
}
