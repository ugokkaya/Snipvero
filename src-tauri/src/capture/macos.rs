//! ScreenCaptureKit backend (macOS 14+: `SCScreenshotManager`, `SCShareableContent.infoForFilter`).

use std::ptr::NonNull;
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::AllocAnyThread;
use objc2::rc::Retained;
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{
    CGDataProvider, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo,
    CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess,
};
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{
    SCCaptureResolutionType, SCContentFilter, SCRunningApplication, SCScreenshotManager,
    SCShareableContent, SCStreamConfiguration,
};

use super::{CaptureError, CaptureTimings, Frame};
use crate::geometry::{LogicalRect, physical_size};

const TIMEOUT: Duration = Duration::from_secs(5);
/// `kCVPixelFormatType_32BGRA`.
pub(crate) const PIXEL_FORMAT_BGRA: u32 = u32::from_be_bytes(*b"BGRA");
/// `SCStreamErrorUserDeclined`.
const ERROR_USER_DECLINED: isize = -3801;

pub fn has_permission() -> bool {
    CGPreflightScreenCaptureAccess()
}

pub fn request_permission() {
    CGRequestScreenCaptureAccess();
}

/// The last display/application enumeration. Asking ScreenCaptureKit again costs ~100 ms on every
/// capture, which is the largest single part of the delay before the overlay appears. The
/// snapshot only lists displays and apps (windows are captured live), so it stays valid until
/// the display arrangement changes; `invalidate_cache` is called then.
struct Cached(Retained<SCShareableContent>);

// SAFETY: an `SCShareableContent` is an immutable snapshot; it is only read after creation.
unsafe impl Send for Cached {}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

pub fn invalidate_cache() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

/// The cached enumeration, or a fresh one. `fresh` skips the cache.
fn content(fresh: bool) -> Result<(Retained<SCShareableContent>, bool), CaptureError> {
    if !fresh
        && let Ok(cache) = CACHE.lock()
        && let Some(Cached(content)) = cache.as_ref()
    {
        return Ok((content.clone(), true));
    }
    let content = shareable_content()?;
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some(Cached(content.clone()));
    }
    Ok((content, false))
}

pub fn capture_displays() -> Result<(Vec<Frame>, CaptureTimings), CaptureError> {
    if !has_permission() {
        return Err(CaptureError::PermissionDenied);
    }
    match capture_with(false) {
        // A stale snapshot (a display changed without a notification) fails or times out:
        // enumerate again once before giving up.
        Err(CaptureError::Failed(_)) => {
            invalidate_cache();
            capture_with(true)
        }
        result => result,
    }
}

fn capture_with(fresh: bool) -> Result<(Vec<Frame>, CaptureTimings), CaptureError> {
    let started = Instant::now();
    let (content, _cached) = content(fresh)?;
    let enumerate_ms = elapsed_ms(started);

    // Exclude our own windows (main window, stale overlays) from the frozen image.
    let excluded_apps = own_applications(&content);
    let no_windows = NSArray::new();

    // Issue all display captures before waiting, so the displays are frozen at about the same time.
    let started = Instant::now();
    let mut pending = Vec::new();
    for display in unsafe { content.displays() }.iter() {
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                SCContentFilter::alloc(),
                &display,
                &excluded_apps,
                &no_windows,
            )
        };
        let scale =
            f64::from(unsafe { SCShareableContent::infoForFilter(&filter).pointPixelScale() });
        let frame = unsafe { display.frame() };
        let bounds = LogicalRect {
            x: frame.origin.x,
            y: frame.origin.y,
            width: frame.size.width,
            height: frame.size.height,
        };
        let (width, height) = physical_size(bounds.width, bounds.height, scale);
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(width as usize);
            config.setHeight(height as usize);
            config.setShowsCursor(false);
            config.setPixelFormat(PIXEL_FORMAT_BGRA);
            config.setCaptureResolution(SCCaptureResolutionType::Best);
        }
        let receiver = capture_image(&filter, &config);
        pending.push((unsafe { display.displayID() }, bounds, scale, receiver));
    }

    let mut images = Vec::with_capacity(pending.len());
    for (display_id, bounds, scale, receiver) in pending {
        let image = receiver
            .recv_timeout(TIMEOUT)
            .map_err(|_| CaptureError::Failed("timed out waiting for a display image".into()))??;
        images.push((display_id, bounds, scale, image));
    }
    let capture_ms = elapsed_ms(started);

    let started = Instant::now();
    let frames = images
        .into_iter()
        .map(|(display_id, bounds, scale, image)| {
            let (width, height, bgra) = image_bgra(&image)?;
            Ok(Frame {
                display_id,
                bounds,
                scale,
                width,
                height,
                bgra,
            })
        })
        .collect::<Result<Vec<_>, CaptureError>>()?;
    let copy_ms = elapsed_ms(started);

    Ok((
        frames,
        CaptureTimings {
            enumerate_ms,
            capture_ms,
            copy_ms,
        },
    ))
}

/// Snipvero itself, for the content filters: its windows (overlays, indicator, review) never
/// appear in a screenshot or a recording (ADR-008, ADR-037).
pub(crate) fn own_applications(
    content: &SCShareableContent,
) -> Retained<NSArray<SCRunningApplication>> {
    let own_pid = std::process::id() as i32;
    let own_apps: Vec<Retained<SCRunningApplication>> = unsafe { content.applications() }
        .iter()
        .filter(|app| unsafe { app.processID() } == own_pid)
        .collect();
    NSArray::from_retained_slice(&own_apps)
}

pub(crate) fn shareable_content() -> Result<Retained<SCShareableContent>, CaptureError> {
    let (tx, rx) = mpsc::sync_channel(1);
    let handler = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            let result =
                unsafe { Retained::retain(content) }.ok_or_else(|| to_capture_error(error));
            let _ = tx.send(result);
        },
    );
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&handler) };
    rx.recv_timeout(TIMEOUT)
        .map_err(|_| CaptureError::Failed("timed out enumerating displays".into()))?
}

fn capture_image(
    filter: &SCContentFilter,
    config: &SCStreamConfiguration,
) -> mpsc::Receiver<Result<CFRetained<CGImage>, CaptureError>> {
    let (tx, rx) = mpsc::sync_channel(1);
    let handler = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        // The image is only borrowed for the duration of the callback, so retain it.
        let result = NonNull::new(image)
            .map(|image| unsafe { CFRetained::retain(image) })
            .ok_or_else(|| to_capture_error(error));
        let _ = tx.send(result);
    });
    unsafe {
        SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
            filter,
            config,
            Some(&handler),
        )
    };
    rx
}

fn to_capture_error(error: *mut NSError) -> CaptureError {
    match unsafe { error.as_ref() } {
        Some(error) if error.code() == ERROR_USER_DECLINED => CaptureError::PermissionDenied,
        Some(error) => CaptureError::Failed(error.localizedDescription().to_string()),
        None => CaptureError::Failed("no image and no error returned".into()),
    }
}

/// Copies the image into tightly packed BGRA rows, dropping any row padding.
fn image_bgra(image: &CGImage) -> Result<(u32, u32, Vec<u8>), CaptureError> {
    let image = Some(image);
    let width = CGImage::width(image);
    let height = CGImage::height(image);
    let stride = CGImage::bytes_per_row(image);
    let bits = CGImage::bits_per_pixel(image);
    let order = CGImage::byte_order_info(image);
    let alpha = CGImage::alpha_info(image);
    let alpha_ok = [
        CGImageAlphaInfo::PremultipliedFirst,
        CGImageAlphaInfo::First,
        CGImageAlphaInfo::NoneSkipFirst,
    ]
    .contains(&alpha);
    if bits != 32 || order != CGImageByteOrderInfo::Order32Little || !alpha_ok {
        return Err(CaptureError::Failed(format!(
            "unexpected pixel layout: {bits} bpp, {order:?}, {alpha:?}"
        )));
    }

    let provider = CGImage::data_provider(image)
        .ok_or_else(|| CaptureError::Failed("image has no data provider".into()))?;
    let data = CGDataProvider::data(Some(&provider))
        .ok_or_else(|| CaptureError::Failed("could not read image data".into()))?;
    // SAFETY: `data` is immutable and outlives `bytes`.
    let bytes = unsafe { data.as_bytes_unchecked() };

    let row = width * 4;
    if height == 0 || stride < row || bytes.len() < stride * (height - 1) + row {
        return Err(CaptureError::Failed(
            "image buffer smaller than expected".into(),
        ));
    }
    let mut bgra = Vec::with_capacity(row * height);
    for y in 0..height {
        bgra.extend_from_slice(&bytes[y * stride..y * stride + row]);
    }
    Ok((width as u32, height as u32, bgra))
}

fn elapsed_ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}
