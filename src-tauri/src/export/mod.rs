//! Export of the selected region: one composition pipeline for the clipboard and PNG files.
//!
//! The overlay page rasterizes its annotations with the same Konva shapes as the preview, into an
//! RGBA layer exactly the size of the region (so anything outside is already clipped), and sends
//! it as a raw IPC body. Rust crops the frame it still holds in memory, alpha-blends the layer
//! over it and encodes or copies the result. The screenshot never travels back over IPC, nothing
//! is base64-encoded, and no intermediate file is written: only the file the user chose (ADR-018).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::capture::Frame;
use crate::events;
use crate::geometry::PixelRect;
use crate::overlay::{self, CaptureState};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// IPC headers carrying the request metadata next to the raw layer body. Mirrored in `src/ipc.ts`.
const SESSION_HEADER: &str = "x-snipvero-session";
const REGION_HEADER: &str = "x-snipvero-region";
const FILE_NAME_HEADER: &str = "x-snipvero-file-name";
const MAX_FILE_NAME: usize = 128;

/// An opaque RGBA8 image, rows tightly packed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportOutcome {
    /// Copied or saved; the overlays are closed.
    Done,
    /// The save dialog was dismissed; the overlays stay open.
    Cancelled,
}

/// Crops `region` out of `frame` and blends `layer` over it. `layer` is either empty (no
/// annotations) or straight-alpha RGBA of exactly the region's size, as `getImageData` returns.
pub fn compose(frame: &Frame, region: PixelRect, layer: &[u8]) -> Result<Image, String> {
    if !region.fits(frame.width, frame.height) {
        return Err(format!(
            "region {region:?} is empty or outside the {}×{} frame",
            frame.width, frame.height
        ));
    }
    let frame_stride = frame.width as usize * 4;
    if frame.bgra.len() != frame_stride * frame.height as usize {
        return Err("captured frame has an unexpected size".into());
    }
    let row = region.width as usize * 4;
    let size = row * region.height as usize;
    if !layer.is_empty() && layer.len() != size {
        return Err(format!(
            "annotation layer has {} bytes, expected {size} for {}×{}",
            layer.len(),
            region.width,
            region.height
        ));
    }
    let mut rgba = Vec::with_capacity(size);
    for y in 0..region.height as usize {
        let start = (region.y as usize + y) * frame_stride + region.x as usize * 4;
        for px in frame.bgra[start..start + row].as_chunks::<4>().0 {
            // The capture is opaque; force it so no consumer sees a stray transparent pixel.
            rgba.extend_from_slice(&[px[2], px[1], px[0], 255]);
        }
    }
    if !layer.is_empty() {
        for (dst, src) in rgba
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .zip(layer.as_chunks::<4>().0)
        {
            blend(dst, src);
        }
    }
    Ok(Image {
        width: region.width,
        height: region.height,
        rgba,
    })
}

/// Source-over onto an opaque pixel, with straight (non-premultiplied) source alpha.
fn blend(dst: &mut [u8; 4], src: &[u8; 4]) {
    let alpha = u32::from(src[3]);
    match alpha {
        0 => {}
        255 => dst[..3].copy_from_slice(&src[..3]),
        _ => {
            for i in 0..3 {
                let value = u32::from(src[i]) * alpha + u32::from(dst[i]) * (255 - alpha);
                dst[i] = ((value + 127) / 255) as u8;
            }
        }
    }
}

/// Encodes as an 8-bit RGBA PNG at the image's full pixel size.
pub fn encode_png(image: &Image, compression: png::Compression) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(compression);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer
        .write_image_data(&image.rgba)
        .map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(out)
}

/// Parses the `x,y,width,height` region header.
pub fn parse_region(value: &str) -> Result<PixelRect, String> {
    let parts: Vec<u32> = value
        .split(',')
        .map(|part| part.trim().parse::<u32>())
        .collect::<Result<_, _>>()
        .map_err(|_| format!("invalid region {value:?}"))?;
    match parts[..] {
        [x, y, width, height] => Ok(PixelRect {
            x,
            y,
            width,
            height,
        }),
        _ => Err(format!("invalid region {value:?}")),
    }
}

/// The suggested name comes from the page (it knows the local time); accept only a plain
/// `*.png` file name, never a path.
pub fn valid_file_name(name: &str) -> bool {
    name.len() <= MAX_FILE_NAME
        && name.len() > ".png".len()
        && name.ends_with(".png")
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// Writes `bytes` to `path` through a hidden sibling file renamed over it, so a failed write
/// (a full disk, a removed volume) never leaves a truncated PNG or destroys the file the user
/// chose to replace. The sibling is removed again on failure.
///
/// The sibling is only ever created, never opened if it exists: anyone who can write to the
/// folder could otherwise plant a symlink under its name and have the image written through it
/// over another file. A replaced file keeps its permission bits, so a private file stays private.
pub fn write_replacing(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("no file name"))?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Ok(existing) = std::fs::symlink_metadata(path)
        && existing.is_file()
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        options.mode(existing.mode() & 0o777);
    }
    let (partial, mut file) = create_partial(path, name, &options)?;
    let result = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            drop(file);
            std::fs::rename(&partial, path)
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&partial);
    }
    result
}

/// Creates a hidden sibling of `path` with a name no one else holds, retrying on a name taken
/// by a leftover or a planted entry instead of reusing it.
fn create_partial(
    path: &Path,
    name: &std::ffi::OsStr,
    options: &std::fs::OpenOptions,
) -> std::io::Result<(PathBuf, std::fs::File)> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    const ATTEMPTS: u32 = 16;
    for _ in 0..ATTEMPTS {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |since| since.subsec_nanos());
        let mut partial = OsString::from(".");
        partial.push(name);
        partial.push(format!(
            ".{}-{}-{nanos}.snipvero-partial",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let partial = path.with_file_name(partial);
        match options.open(&partial) {
            Ok(file) => return Ok((partial, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "no free name for the temporary file",
    ))
}

/// Puts the image on the system clipboard as an image (not a path or encoded text).
fn copy_to_clipboard(image: &Image) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return macos::copy_image(image);
    #[cfg(target_os = "windows")]
    return windows::copy_image(image);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = image;
        Err("the clipboard is not supported on this platform".into())
    }
}

/// The metadata and layer of an export request, checked before anything is locked.
#[derive(Debug, PartialEq, Eq)]
struct Parsed<'a> {
    session: u64,
    region: PixelRect,
    layer: &'a [u8],
    /// Only for saving.
    file_name: Option<String>,
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, String> {
    headers
        .get(name)
        .ok_or_else(|| format!("missing {name}"))?
        .to_str()
        .map_err(|_| format!("invalid {name}"))
}

/// Validates everything the page sent. Every request error surfaces here, before `begin` takes
/// the export lock: once it is taken only `finish` releases it, and a lock left behind would
/// refuse every later copy or save of the capture.
fn parse<'a>(headers: &HeaderMap, body: &'a InvokeBody, save: bool) -> Result<Parsed<'a>, String> {
    let session = header(headers, SESSION_HEADER)?
        .parse::<u64>()
        .map_err(|_| "invalid session")?;
    let region = parse_region(header(headers, REGION_HEADER)?)?;
    let layer = match body {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        InvokeBody::Json(_) => return Err("expected the annotation layer as raw bytes".into()),
    };
    let file_name = if save {
        let name = header(headers, FILE_NAME_HEADER)?;
        if !valid_file_name(name) {
            return Err(format!("invalid file name {name:?}"));
        }
        Some(name.to_owned())
    } else {
        None
    };
    Ok(Parsed {
        session,
        region,
        layer,
        file_name,
    })
}

/// A started export: the frame stays shared, the layer stays in the IPC body.
struct Job {
    session: u64,
    frame: std::sync::Arc<Frame>,
    region: PixelRect,
}

/// Marks the session as exporting, so a repeated request is rejected. Must be followed by `finish`.
fn begin(app: &AppHandle, window: &WebviewWindow, request: &Parsed<'_>) -> Result<Job, String> {
    let index = overlay::index_from_label(window.label()).ok_or("not an overlay window")?;
    let (session, region) = (request.session, request.region);
    let (frame, previous) = app
        .state::<CaptureState>()
        .begin_export(session, index, region)?;
    if let Some(previous) = previous {
        let _ = app.emit_to(
            overlay::label(previous),
            events::OVERLAY_SELECTION_CLEARED,
            session,
        );
    }
    Ok(Job {
        session,
        frame,
        region,
    })
}

/// Ends the export: closes the overlays on success, otherwise lets the user try again.
fn finish(app: &AppHandle, session: u64, result: &Result<ExportOutcome, String>) {
    let state = app.state::<CaptureState>();
    match result {
        Ok(ExportOutcome::Done) if state.end_export(session) => {
            // Only this capture: Escape may have ended it, and a new one started, meanwhile.
            overlay::close_on_main_thread(app, session, None);
        }
        Ok(_) => {
            state.end_export(session);
        }
        Err(err) => {
            eprintln!("[export] {err}");
            state.end_export(session);
        }
    }
}

/// Composes the region with its annotations and copies it to the clipboard.
/// Header `x-snipvero-session`, `x-snipvero-region`; body: the annotation layer or empty.
#[tauri::command]
pub async fn overlay_copy(
    app: AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<ExportOutcome, String> {
    let parsed = parse(request.headers(), request.body(), false)?;
    let job = begin(&app, &window, &parsed)?;
    let result = compose(&job.frame, job.region, parsed.layer)
        .and_then(|image| {
            copy_to_clipboard(&image)?;
            eprintln!("[export] copied {}×{} px", image.width, image.height);
            Ok(ExportOutcome::Done)
        })
        .map_err(|e| format!("Could not copy the screenshot: {e}"));
    finish(&app, job.session, &result);
    result
}

/// Asks for a file name, then composes the region with its annotations and saves it as PNG.
/// Headers as `overlay_copy`, plus `x-snipvero-file-name` (the suggested name).
#[tauri::command]
pub async fn overlay_save(
    app: AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<ExportOutcome, String> {
    let parsed = parse(request.headers(), request.body(), true)?;
    let name = parsed.file_name.clone().unwrap_or_default();
    let job = begin(&app, &window, &parsed)?;
    let result = save(&app, &window, &job, parsed.layer, name).await;
    finish(&app, job.session, &result);
    result
}

/// Developer harness (`--stress-export`): one export of the focused display's central quarter,
/// with an annotation-sized layer, through the same lock, composition, PNG + TIFF conversion
/// and close as a real copy, but onto a private pasteboard so the user's clipboard is untouched.
/// The page's rasterization is not part of it. Returns a log line.
pub fn stress_export(app: &AppHandle, session: u64) -> Result<String, String> {
    let state = app.state::<CaptureState>();
    let index = state
        .session()
        .as_ref()
        .filter(|s| s.id == session)
        .map(|s| s.focus)
        .ok_or("capture no longer active")?;
    let (width, height) = {
        let (_, frame) = state.frame(index)?;
        (frame.width, frame.height)
    };
    let region = PixelRect {
        x: width / 4,
        y: height / 4,
        width: (width / 2).max(1),
        height: (height / 2).max(1),
    };
    // Opaque stripes over half the rows, as a stand-in for drawn annotations.
    let stripe = [255, 59, 48, 255].repeat(region.width as usize);
    let mut layer = vec![0u8; stripe.len() * region.height as usize];
    for line in layer.chunks_exact_mut(stripe.len()).step_by(2) {
        line.copy_from_slice(&stripe);
    }
    let (frame, _) = state.begin_export(session, index, region)?;
    let result = compose(&frame, region, &layer).and_then(|image| {
        let sizes = copy_isolated(&image)?;
        Ok((image.width, image.height, sizes))
    });
    drop(frame);
    let outcome = result
        .as_ref()
        .map(|_| ExportOutcome::Done)
        .map_err(Clone::clone);
    finish(app, session, &outcome);
    result.map(|(w, h, (png, tiff))| format!("{w}×{h} px, PNG {png} B, TIFF {tiff} B"))
}

/// See `stress_export`. Where no private clipboard exists, only the PNG is encoded.
fn copy_isolated(image: &Image) -> Result<(usize, usize), String> {
    #[cfg(target_os = "macos")]
    return macos::copy_image_isolated(image);
    #[cfg(not(target_os = "macos"))]
    Ok((encode_png(image, png::Compression::Fast)?.len(), 0))
}

async fn save(
    app: &AppHandle,
    window: &WebviewWindow,
    job: &Job,
    layer: &[u8],
    name: String,
) -> Result<ExportOutcome, String> {
    // Validate before asking, so a bad request never shows a dialog.
    let image = compose(&job.frame, job.region, layer)?;
    let Some(path) = choose_path(app, window, name).await? else {
        eprintln!("[export] save dialog cancelled");
        return Ok(ExportOutcome::Cancelled);
    };
    let png = encode_png(&image, png::Compression::Balanced)?;
    write_replacing(&path, &png).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    eprintln!(
        "[export] saved {}×{} px to {}",
        image.width,
        image.height,
        path.display()
    );
    Ok(ExportOutcome::Done)
}

/// The native save dialog, on a blocking thread (rfd runs the panel on the main thread on macOS).
/// It is owned by the overlay it was requested from: a sheet on that display on macOS, an owned
/// window above the topmost overlay on Windows. On macOS the overlays step down below it meanwhile.
async fn choose_path(
    app: &AppHandle,
    window: &WebviewWindow,
    name: String,
) -> Result<Option<PathBuf>, String> {
    let dialog = rfd::FileDialog::new()
        .set_title("Save screenshot")
        .set_file_name(name)
        .add_filter("PNG image", &["png"])
        .set_parent(window);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        overlay::set_dialog_open(&app, true);
        let path = dialog.save_file();
        overlay::set_dialog_open(&app, false);
        path
    })
    .await
    .map_err(|e| format!("save dialog failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::LogicalRect;

    /// A frame whose pixel at (x, y) is BGRA (x, y, 7, 255), so every crop position is checkable.
    fn frame(width: u32, height: u32, scale: f64) -> Frame {
        let mut bgra = Vec::new();
        for y in 0..height {
            for x in 0..width {
                bgra.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, 7, 255]);
            }
        }
        Frame {
            display_id: 1,
            bounds: LogicalRect {
                x: 0.0,
                y: 0.0,
                width: f64::from(width) / scale,
                height: f64::from(height) / scale,
            },
            scale,
            width,
            height,
            bgra,
        }
    }

    const fn rect(x: u32, y: u32, width: u32, height: u32) -> PixelRect {
        PixelRect {
            x,
            y,
            width,
            height,
        }
    }

    fn pixel(image: &Image, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * image.width + x) * 4) as usize;
        [
            image.rgba[i],
            image.rgba[i + 1],
            image.rgba[i + 2],
            image.rgba[i + 3],
        ]
    }

    #[test]
    fn crops_exact_pixels_and_converts_to_opaque_rgba() {
        let image = compose(&frame(40, 30, 1.0), rect(5, 6, 10, 4), &[]).unwrap();
        assert_eq!((image.width, image.height), (10, 4));
        assert_eq!(image.rgba.len(), 10 * 4 * 4);
        // RGBA = (7, y, x, 255): blue and red swapped from BGRA.
        assert_eq!(pixel(&image, 0, 0), [7, 6, 5, 255]);
        assert_eq!(pixel(&image, 9, 3), [7, 9, 14, 255]);
    }

    #[test]
    fn crops_at_frame_edges_and_the_full_frame() {
        let f = frame(40, 30, 1.0);
        let corner = compose(&f, rect(39, 29, 1, 1), &[]).unwrap();
        assert_eq!(pixel(&corner, 0, 0), [7, 29, 39, 255]);
        let full = compose(&f, rect(0, 0, 40, 30), &[]).unwrap();
        assert_eq!(full.rgba.len(), f.bgra.len());
    }

    #[test]
    fn keeps_physical_resolution_on_retina_and_fractional_scales() {
        // Built-in Retina 1512×982 pt @2×: a 200×150 pt region is 400×300 px, unscaled.
        let retina = frame(3024, 1964, 2.0);
        let image = compose(&retina, rect(200, 100, 400, 300), &[]).unwrap();
        assert_eq!((image.width, image.height), (400, 300));
        assert_eq!(
            pixel(&image, 399, 299),
            [7, (399 % 256) as u8, (599 % 256) as u8, 255]
        );
        // 1.5×: 1706.67 pt wide = 2560 px. The region is already in pixels, so odd sizes stay exact.
        let fractional = frame(2560, 1440, 1.5);
        let image = compose(&fractional, rect(1, 3, 2559, 1437), &[]).unwrap();
        assert_eq!((image.width, image.height), (2559, 1437));
        assert_eq!(pixel(&image, 0, 0), [7, 3, 1, 255]);
    }

    #[test]
    fn rejects_regions_outside_the_frame_and_empty_regions() {
        let f = frame(40, 30, 1.0);
        assert!(compose(&f, rect(31, 0, 10, 10), &[]).is_err());
        assert!(compose(&f, rect(0, 21, 10, 10), &[]).is_err());
        assert!(compose(&f, rect(0, 0, 0, 10), &[]).is_err());
        assert!(compose(&f, rect(u32::MAX, 0, 2, 2), &[]).is_err());
    }

    #[test]
    fn rejects_a_layer_of_the_wrong_size() {
        let f = frame(40, 30, 1.0);
        assert!(compose(&f, rect(0, 0, 2, 2), &[0; 15]).is_err());
        assert!(compose(&f, rect(0, 0, 2, 2), &[0; 20]).is_err());
        assert!(compose(&f, rect(0, 0, 2, 2), &[0; 16]).is_ok());
    }

    #[test]
    fn blends_the_annotation_layer_with_straight_alpha() {
        let f = frame(4, 1, 1.0);
        // Transparent, opaque red, half-transparent white, nearly transparent black.
        let layer = [
            0, 0, 0, 0, //
            255, 0, 0, 255, //
            255, 255, 255, 128, //
            0, 0, 0, 1,
        ];
        let image = compose(&f, rect(0, 0, 4, 1), &layer).unwrap();
        assert_eq!(pixel(&image, 0, 0), [7, 0, 0, 255]);
        assert_eq!(pixel(&image, 1, 0), [255, 0, 0, 255]);
        // (255·128 + d·127 + 127) / 255 per channel, over (7, 0, 2).
        assert_eq!(pixel(&image, 2, 0), [131, 128, 129, 255]);
        assert_eq!(pixel(&image, 3, 0), [7, 0, 3, 255]);
    }

    #[test]
    fn empty_layer_keeps_the_screenshot_unchanged() {
        let f = frame(8, 8, 1.0);
        let plain = compose(&f, rect(1, 1, 6, 6), &[]).unwrap();
        let transparent = compose(&f, rect(1, 1, 6, 6), &[0; 6 * 6 * 4]).unwrap();
        assert_eq!(plain, transparent);
    }

    #[test]
    fn png_round_trips_at_full_size() {
        let image = compose(&frame(300, 200, 2.0), rect(17, 9, 251, 133), &[]).unwrap();
        for compression in [png::Compression::Fast, png::Compression::Balanced] {
            let bytes = encode_png(&image, compression).unwrap();
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
            let mut reader = decoder.read_info().unwrap();
            let mut buf = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut buf).unwrap();
            assert_eq!((info.width, info.height), (251, 133));
            assert_eq!(info.color_type, png::ColorType::Rgba);
            assert_eq!(&buf[..info.buffer_size()], &image.rgba[..]);
        }
    }

    #[test]
    fn parses_region_headers() {
        assert_eq!(parse_region("10,20,300,200"), Ok(rect(10, 20, 300, 200)));
        assert_eq!(parse_region(" 0, 0, 1, 1"), Ok(rect(0, 0, 1, 1)));
        assert!(parse_region("10,20,300").is_err());
        assert!(parse_region("10,20,300,200,1").is_err());
        assert!(parse_region("-1,0,1,1").is_err());
        assert!(parse_region("1.5,0,1,1").is_err());
        assert!(parse_region("").is_err());
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        pairs
            .iter()
            .map(|&(name, value)| {
                (
                    tauri::http::HeaderName::from_static(name),
                    tauri::http::HeaderValue::from_static(value),
                )
            })
            .collect()
    }

    #[test]
    fn parses_every_request_error_before_the_export_starts() {
        let ok = headers(&[
            (SESSION_HEADER, "7"),
            (REGION_HEADER, "1,2,3,4"),
            (FILE_NAME_HEADER, "Snipvero-2026-10-30-143000.png"),
        ]);
        let body = InvokeBody::Raw(vec![0; 48]);
        let parsed = parse(&ok, &body, true).unwrap();
        assert_eq!((parsed.session, parsed.region), (7, rect(1, 2, 3, 4)));
        assert_eq!(parsed.layer.len(), 48);
        assert_eq!(
            parsed.file_name.as_deref(),
            Some("Snipvero-2026-10-30-143000.png")
        );
        assert_eq!(parse(&ok, &body, false).unwrap().file_name, None);
        // Regression: a JSON body used to be rejected only after the export lock was taken,
        // which then refused every later copy and save of the capture.
        let json = InvokeBody::default();
        assert!(matches!(json, InvokeBody::Json(_)));
        assert!(parse(&ok, &json, false).is_err());
        let no_name = headers(&[(SESSION_HEADER, "7"), (REGION_HEADER, "1,2,3,4")]);
        assert!(parse(&no_name, &body, true).is_err());
        let bad_name = headers(&[
            (SESSION_HEADER, "7"),
            (REGION_HEADER, "1,2,3,4"),
            (FILE_NAME_HEADER, "../x.png"),
        ]);
        assert!(parse(&bad_name, &body, true).is_err());
        assert!(parse(&headers(&[(REGION_HEADER, "1,2,3,4")]), &body, false).is_err());
        assert!(parse(&headers(&[(SESSION_HEADER, "x")]), &body, false).is_err());
    }

    /// A fresh directory under the system temp dir, removed by the test.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("snipvero-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn replaces_the_chosen_file_completely_and_leaves_nothing_else() {
        let dir = scratch_dir("write");
        let path = dir.join("Snipvero.png");
        std::fs::write(&path, b"an older, longer file").unwrap();
        write_replacing(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(entries.len(), 1, "no partial file is left behind");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_write_keeps_the_existing_file() {
        let dir = scratch_dir("fail");
        // The target is a non-empty directory: the rename fails after the data was written.
        let path = dir.join("Snipvero.png");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep"), b"x").unwrap();
        assert!(write_replacing(&path, b"new").is_err());
        assert!(path.join("keep").exists());
        let entries: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
        assert_eq!(entries.len(), 1, "the partial file is removed");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_symlink_does_not_redirect_the_write() {
        let dir = scratch_dir("symlink");
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, b"keep").unwrap();
        // The temporary name this function used to derive from the file name alone.
        std::os::unix::fs::symlink(&victim, dir.join(".Snipvero.png.snipvero-partial")).unwrap();
        let path = dir.join("Snipvero.png");
        write_replacing(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("mode");
        let path = dir.join("Snipvero.png");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_replacing(&path, b"new").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_taken_temporary_name_is_skipped() {
        let dir = scratch_dir("taken");
        let path = dir.join("Snipvero.png");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        let (first, _file) =
            create_partial(&path, std::ffi::OsStr::new("Snipvero.png"), &options).unwrap();
        let (second, _file) =
            create_partial(&path, std::ffi::OsStr::new("Snipvero.png"), &options).unwrap();
        assert_ne!(first, second);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn accepts_only_plain_png_file_names() {
        assert!(valid_file_name("Snipvero-2026-10-30-143000.png"));
        assert!(!valid_file_name("Snipvero.jpg"));
        assert!(!valid_file_name(".png"));
        assert!(!valid_file_name(".hidden.png"));
        assert!(!valid_file_name("../Snipvero.png"));
        assert!(!valid_file_name("dir/Snipvero.png"));
        assert!(!valid_file_name("C:\\Snipvero.png"));
        assert!(!valid_file_name("Çığır.png"));
        assert!(!valid_file_name(&format!(
            "{}.png",
            "a".repeat(MAX_FILE_NAME)
        )));
    }
}
