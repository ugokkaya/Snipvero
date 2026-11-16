//! The MP4 → pictures frame source of the GIF export (ADR-037, task 4): an `AVAssetReader` on the
//! finished recording, decoding to BGRA one picture at a time. No second capture and no second
//! pipeline: the file the recording wrote is the only input.
//!
//! Streaming: each picture is handed to the callback while its pixel buffer is locked and released
//! right after, so memory does not grow with the length of the recording. The callback runs on the
//! calling thread, which is a worker (decoding blocks).

use std::path::Path;
use std::slice;
use std::sync::atomic::{AtomicBool, Ordering};

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVAssetReader, AVAssetReaderStatus, AVAssetReaderTrackOutput, AVMediaTypeVideo, AVURLAsset,
};
use objc2_core_foundation::CFString;
use objc2_core_video::{
    CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
    CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress,
    CVPixelBufferLockFlags, CVPixelBufferUnlockBaseAddress, kCVPixelBufferPixelFormatTypeKey,
    kCVPixelFormatType_32BGRA, kCVReturnSuccess,
};
use objc2_foundation::{NSDictionary, NSString, NSURL};

use super::{error_text, number};
use crate::recording::gif::{Picture, ReadError};

/// Calls `on_picture` for every picture of the video track of `path`, in presentation order. Stops
/// with `Cancelled` when `cancel` is set (checked before each picture), and with `Failed` when the
/// file cannot be read or the callback returns an error.
pub fn read_pictures(
    path: &Path,
    cancel: &AtomicBool,
    on_picture: &mut dyn FnMut(Picture<'_>) -> Result<(), String>,
) -> Result<(), ReadError> {
    let failed = |reason: &str| ReadError::Failed(reason.to_string());
    let url = NSURL::fileURLWithPath(&NSString::from_str(
        path.to_str()
            .ok_or_else(|| failed("the recording path is not valid UTF-8"))?,
    ));
    // SAFETY: a fresh asset of a local file.
    let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };
    // SAFETY: an immutable framework constant.
    let video =
        unsafe { AVMediaTypeVideo }.ok_or_else(|| failed("AVFoundation has no video type"))?;
    // The asynchronous loader needs a run loop; a local, finished file is ready at once.
    #[allow(deprecated)]
    // SAFETY: a plain query of the asset.
    let tracks = unsafe { asset.tracksWithMediaType(video) };
    let track = tracks
        .firstObject()
        .ok_or_else(|| failed("the recording has no video track"))?;

    // SAFETY: a fresh reader on the asset above.
    let reader = unsafe { AVAssetReader::assetReaderWithAsset_error(&asset) }
        .map_err(|error| ReadError::Failed(error_text(&error)))?;
    // SAFETY: an immutable framework constant, read as the NSString it is.
    let key: &NSString =
        unsafe { &*std::ptr::from_ref::<CFString>(kCVPixelBufferPixelFormatTypeKey).cast() };
    let settings: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> =
        NSDictionary::from_retained_objects(&[key], &[number(kCVPixelFormatType_32BGRA)]);
    // SAFETY: the track belongs to the asset the reader reads.
    let output = unsafe {
        AVAssetReaderTrackOutput::assetReaderTrackOutputWithTrack_outputSettings(
            &track,
            Some(&settings),
        )
    };
    // SAFETY: configuration before reading starts.
    unsafe {
        // The pictures are only read, never kept: no copy needed.
        output.setAlwaysCopiesSampleData(false);
        if !reader.canAddOutput(&output) {
            return Err(failed("the recording cannot be decoded to pictures"));
        }
        reader.addOutput(&output);
        if !reader.startReading() {
            return Err(ReadError::Failed(reader.error().map_or_else(
                || "the recording could not be opened".to_string(),
                |error| error_text(&error),
            )));
        }
    }

    loop {
        if cancel.load(Ordering::SeqCst) {
            // SAFETY: stops the reader; nothing reads from it afterwards.
            unsafe { reader.cancelReading() };
            return Err(ReadError::Cancelled);
        }
        // One pool per picture: this thread has none of its own, and a long video would
        // otherwise hold every autoreleased object until it ended.
        let more = autoreleasepool(|_| -> Result<bool, ReadError> {
            // SAFETY: the reader is reading.
            let Some(sample) = (unsafe { output.copyNextSampleBuffer() }) else {
                return Ok(false);
            };
            // SAFETY: plain reads of a valid sample buffer.
            let Some(buffer) = (unsafe { sample.image_buffer() }) else {
                return Ok(true); // Not a picture (no pixel data); skip it.
            };
            if CVPixelBufferGetPixelFormatType(&buffer) != kCVPixelFormatType_32BGRA {
                return Err(failed("the decoder did not deliver BGRA pictures"));
            }
            // SAFETY: balanced by the unlock below, on every path.
            if unsafe { CVPixelBufferLockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly) }
                != kCVReturnSuccess
            {
                return Err(failed("a picture could not be read from the decoder"));
            }
            let width = CVPixelBufferGetWidth(&buffer);
            let height = CVPixelBufferGetHeight(&buffer);
            let stride = CVPixelBufferGetBytesPerRow(&buffer);
            let base = CVPixelBufferGetBaseAddress(&buffer).cast::<u8>();
            let result = if base.is_null() || width == 0 || height == 0 || stride < width * 4 {
                Err(failed("a picture of the video is empty"))
            } else {
                // SAFETY: the buffer is locked, so `base` points at `height` rows of `stride`
                // bytes until the unlock; the slice does not outlive the callback.
                let bgra = unsafe { slice::from_raw_parts(base, stride * height) };
                // SAFETY: plain arithmetic on a valid time.
                let time = unsafe { sample.presentation_time_stamp().seconds() };
                on_picture(Picture {
                    time,
                    size: (width as u32, height as u32),
                    stride,
                    bgra,
                })
                .map_err(ReadError::Failed)
            };
            // SAFETY: the lock above.
            unsafe { CVPixelBufferUnlockBaseAddress(&buffer, CVPixelBufferLockFlags::ReadOnly) };
            result.map(|()| true)
        })?;
        if !more {
            break;
        }
    }
    // SAFETY: a plain property read.
    if unsafe { reader.status() } == AVAssetReaderStatus::Failed {
        return Err(ReadError::Failed(reader.error_text()));
    }
    Ok(())
}

trait ReaderError {
    fn error_text(&self) -> String;
}

impl ReaderError for AVAssetReader {
    fn error_text(&self) -> String {
        // SAFETY: a plain property read.
        unsafe { self.error() }.map_or_else(
            || "the recording could not be decoded".to_string(),
            |error| error_text(&error),
        )
    }
}
