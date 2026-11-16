//! macOS recording: an `SCStream` of one display region feeds an `AVAssetWriter` that encodes
//! H.264 into an MP4 (ADR-037). VideoToolbox does the encoding inside AVFoundation: no codec of
//! our own. System audio (from the same stream) and the microphone (an `AVCaptureSession`) are
//! optional, mixed into one AAC track by `audio`.
//!
//! Threads: `start`, `stop` and `cancel` block on system callbacks, so the caller runs them off
//! the main thread. Frames arrive on a private serial dispatch queue and are appended while holding
//! `Shared::state`; `stop` takes the same lock before it ends the writer's session, so a late frame
//! can never be appended to a finished writer.

mod audio;

use std::path::Path;
use std::ptr::{self, NonNull};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchQueueAttr, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterStatus, AVFileTypeMPEG4, AVMediaTypeAudio,
    AVMediaTypeVideo, AVVideoAllowFrameReorderingKey, AVVideoAverageBitRateKey, AVVideoCodecKey,
    AVVideoCodecTypeH264, AVVideoCompressionPropertiesKey, AVVideoExpectedSourceFrameRateKey,
    AVVideoHeightKey, AVVideoMaxKeyFrameIntervalKey, AVVideoProfileLevelH264HighAutoLevel,
    AVVideoProfileLevelKey, AVVideoWidthKey,
};
use objc2_core_foundation::{CFArray, CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_media::{CMClock, CMSampleBuffer, CMSampleTimingInfo, CMTime, kCMTimeInvalid};
use objc2_foundation::{
    NSArray, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSString, NSURL,
    NSURLVolumeAvailableCapacityForImportantUsageKey,
};
use objc2_screen_capture_kit::{
    SCContentFilter, SCFrameStatus, SCStream, SCStreamConfiguration, SCStreamDelegate,
    SCStreamFrameInfoStatus, SCStreamOutput, SCStreamOutputType,
};

use self::audio::{LATENCY_FRAMES, Microphone, Pipeline};
pub use self::audio::{microphone_access, request_microphone_access};
use super::mixer::{SAMPLE_RATE, Source};
use super::{Finalized, RecordingError, StartRequest};
use crate::capture::{self, PIXEL_FORMAT_BGRA};

pub const SUPPORTED: bool = true;

/// How long the system gets to start the stream, stop it, and finish the file.
const START_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const FINISH_TIMEOUT: Duration = Duration::from_secs(60);
/// SCK keeps this many frames in flight (ADR-037).
const QUEUE_DEPTH: isize = 5;
/// A key frame at least this often, so the file can be scrubbed in the review window.
const KEY_FRAME_SECONDS: u32 = 2;
/// How often mixed audio is handed to the encoder.
const AUDIO_PACE: Duration = Duration::from_millis(100);

/// What the encoder has seen so far. Guarded by `Shared::state`.
#[derive(Default)]
struct WriterState {
    /// The writer's session starts at the first frame's timestamp.
    first: Option<CMTime>,
    last: Option<CMTime>,
    frames: u64,
    dropped: u64,
    /// No frame is appended any more (stopped or cancelled).
    closed: bool,
    /// A failure was reported already; later frames are dropped.
    failed: bool,
    /// The newest picture, kept only while recording with sound (see `hold_last_picture`).
    held: Option<CFRetained<CMSampleBuffer>>,
}

/// State shared between the recorder and the stream's callbacks.
struct Shared {
    writer: Retained<AVAssetWriter>,
    input: Retained<AVAssetWriterInput>,
    state: Mutex<WriterState>,
    on_failure: Arc<dyn Fn(String) + Send + Sync>,
    /// Present when system audio or the microphone is switched on.
    audio: Option<Arc<Pipeline>>,
}

// SAFETY: AVAssetWriter and its input are only touched while holding `state` (appending frames,
// ending the session) or, after `closed` is set, by the one thread that finishes the file.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

impl Shared {
    fn state(&self) -> MutexGuard<'_, WriterState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Appends one screen frame. Calls `on_failure` once, after releasing the lock, if the writer
    /// refuses a frame (a full disk, a lost file).
    fn append(&self, sample: &CMSampleBuffer) {
        let failure = {
            let mut state = self.state();
            if state.closed || state.failed || !is_complete_frame(sample) {
                return;
            }
            // SAFETY: the sample is valid for the duration of the callback.
            let pts = unsafe { sample.presentation_time_stamp() };
            if state.first.is_none() {
                // SAFETY: the writer was started before the stream.
                unsafe { self.writer.startSessionAtSourceTime(pts) };
                state.first = Some(pts);
                if let Some(audio) = &self.audio {
                    audio.start(pts);
                }
            }
            // SAFETY: appending is serialized by the lock; the input is not finished.
            if !unsafe { self.input.isReadyForMoreMediaData() } {
                state.dropped += 1;
                None
            } else if unsafe { self.input.appendSampleBuffer(sample) } {
                state.frames += 1;
                state.last = Some(pts);
                if self.audio.is_some() {
                    // SAFETY: retaining a valid sample for the duration of the recording.
                    state.held = Some(unsafe { CFRetained::retain(NonNull::from(sample)) });
                }
                None
            } else {
                state.failed = true;
                Some(self.writer_error())
            }
        };
        if let Some(message) = failure {
            (self.on_failure)(message);
        }
    }

    /// Hands the mixed audio before frame `until` (the host clock, in output frames) to the AAC
    /// input. Does nothing before the first picture or after the end. Calls `on_failure` once if
    /// the encoder refuses audio.
    fn pump_audio(&self, until: i64) {
        let Some(audio) = &self.audio else { return };
        let failure = {
            let mut state = self.state();
            if state.closed || state.failed || state.first.is_none() {
                return;
            }
            let Some(block) = audio.take(until) else {
                return;
            };
            match audio.append(&block) {
                Ok(_) => None,
                Err(reason) => {
                    state.failed = true;
                    Some(reason)
                }
            }
        };
        if let Some(message) = failure {
            (self.on_failure)(message);
        }
    }

    fn writer_error(&self) -> String {
        // SAFETY: a plain property read.
        unsafe { self.writer.error() }.map_or_else(
            || "the video encoder stopped".to_string(),
            |error| error.localizedDescription().to_string(),
        )
    }

    /// The stream ended without us asking: the display went away, or Screen Recording was turned off.
    fn stream_stopped(&self, reason: String) {
        {
            let mut state = self.state();
            if state.closed || state.failed {
                return;
            }
            state.failed = true;
        }
        (self.on_failure)(reason);
    }
}

/// Whether `sample` carries a finished picture. ScreenCaptureKit also sends status-only buffers
/// (the screen did not change, the stream started or stopped) that have no pixels; appending one
/// would fail the writer.
fn is_complete_frame(sample: &CMSampleBuffer) -> bool {
    // SAFETY: plain reads of a valid sample buffer.
    if !unsafe { sample.is_valid() && sample.data_is_ready() && sample.num_samples() > 0 } {
        return false;
    }
    let Some(attachments) = (unsafe { sample.sample_attachments_array(false) }) else {
        return true;
    };
    // SAFETY: a CFArray of CFDictionary is toll-free bridged to NSArray of NSDictionary.
    let array: &NSArray<NSDictionary<NSString, AnyObject>> =
        unsafe { &*(&*attachments as *const CFArray).cast() };
    let Some(info) = array.firstObject() else {
        return true;
    };
    // SAFETY: an immutable framework constant.
    let key = unsafe { SCStreamFrameInfoStatus };
    let status = info
        .objectForKey(key)
        .and_then(|value| value.downcast_ref::<NSNumber>().map(NSNumber::integerValue));
    status.is_none_or(|status| status == SCFrameStatus::Complete.0)
}

struct Ivars {
    shared: Arc<Shared>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this class has no Drop.
    #[unsafe(super(NSObject))]
    #[ivars = Ivars]
    struct StreamHandler;

    unsafe impl NSObjectProtocol for StreamHandler {}

    unsafe impl SCStreamOutput for StreamHandler {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(
            &self,
            _stream: &SCStream,
            sample: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            let shared = &self.ivars().shared;
            if kind == SCStreamOutputType::Screen {
                shared.append(sample);
            } else if kind == SCStreamOutputType::Audio
                && let Some(audio) = &shared.audio
            {
                audio.ingest(Source::System, sample);
            }
        }
    }

    unsafe impl SCStreamDelegate for StreamHandler {
        #[unsafe(method(stream:didStopWithError:))]
        fn stream_did_stop(&self, _stream: &SCStream, error: &NSError) {
            self.ivars()
                .shared
                .stream_stopped(error.localizedDescription().to_string());
        }
    }
);

impl StreamHandler {
    fn new(shared: Arc<Shared>) -> Retained<Self> {
        let handler = Self::alloc().set_ivars(Ivars { shared });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(handler), init] }
    }
}

/// A running recording.
pub struct Recorder {
    native: Native,
}

/// The framework objects of a recording. They are created on one thread and used from another
/// (the stop); the system documents `SCStream` and `AVAssetWriter` as usable from any thread.
struct Native {
    stream: Retained<SCStream>,
    shared: Arc<Shared>,
    // Kept alive: the stream holds its delegate and outputs weakly.
    _handler: Retained<StreamHandler>,
    _queue: DispatchRetained<DispatchQueue>,
    microphone: Option<Microphone>,
}

// SAFETY: see `Native`; every use is serialized by `Shared::state` or by the owner of `Recorder`.
unsafe impl Send for Native {}

fn number(value: u32) -> Retained<AnyObject> {
    // SAFETY: NSNumber is an object; the dictionary only needs an object.
    unsafe { Retained::cast_unchecked(NSNumber::new_u32(value)) }
}

fn object<T: objc2::Message>(value: Retained<T>) -> Retained<AnyObject> {
    // SAFETY: every Objective-C object is an AnyObject.
    unsafe { Retained::cast_unchecked(value) }
}

fn constant(
    value: Option<&'static NSString>,
    name: &str,
) -> Result<&'static NSString, RecordingError> {
    value.ok_or_else(|| RecordingError::Failed(format!("AVFoundation does not provide {name}")))
}

/// H.264 settings for the video input (ADR-037): High profile at an automatic level, the bitrate
/// derived from the size, key frames every two seconds, no frame reordering (real-time, so no
/// B-frame delay).
fn video_settings(
    width: u32,
    height: u32,
    bitrate: u32,
    fps: u32,
) -> Result<Retained<NSDictionary<NSString, AnyObject>>, RecordingError> {
    // SAFETY: immutable framework constants.
    let (codec_key, codec, width_key, height_key, compression_key) = unsafe {
        (
            constant(AVVideoCodecKey, "AVVideoCodecKey")?,
            constant(AVVideoCodecTypeH264, "AVVideoCodecTypeH264")?,
            constant(AVVideoWidthKey, "AVVideoWidthKey")?,
            constant(AVVideoHeightKey, "AVVideoHeightKey")?,
            constant(
                AVVideoCompressionPropertiesKey,
                "AVVideoCompressionPropertiesKey",
            )?,
        )
    };
    let (bitrate_key, profile_key, profile, rate_key, interval_key, reorder_key) = unsafe {
        (
            constant(AVVideoAverageBitRateKey, "AVVideoAverageBitRateKey")?,
            constant(AVVideoProfileLevelKey, "AVVideoProfileLevelKey")?,
            constant(
                AVVideoProfileLevelH264HighAutoLevel,
                "AVVideoProfileLevelH264HighAutoLevel",
            )?,
            constant(
                AVVideoExpectedSourceFrameRateKey,
                "AVVideoExpectedSourceFrameRateKey",
            )?,
            constant(
                AVVideoMaxKeyFrameIntervalKey,
                "AVVideoMaxKeyFrameIntervalKey",
            )?,
            constant(
                AVVideoAllowFrameReorderingKey,
                "AVVideoAllowFrameReorderingKey",
            )?,
        )
    };
    let compression: Retained<NSDictionary<NSString, AnyObject>> =
        NSDictionary::from_retained_objects(
            &[
                bitrate_key,
                profile_key,
                rate_key,
                interval_key,
                reorder_key,
            ],
            &[
                number(bitrate),
                object(profile.copy_retained()),
                number(fps),
                number(fps * KEY_FRAME_SECONDS),
                object(NSNumber::new_bool(false)),
            ],
        );
    Ok(NSDictionary::from_retained_objects(
        &[codec_key, width_key, height_key, compression_key],
        &[
            object(codec.copy_retained()),
            number(width),
            number(height),
            object(compression),
        ],
    ))
}

trait CopyRetained {
    fn copy_retained(&self) -> Retained<NSString>;
}

impl CopyRetained for NSString {
    fn copy_retained(&self) -> Retained<NSString> {
        // SAFETY: retaining a valid object.
        unsafe { Retained::retain(std::ptr::from_ref(self).cast_mut()) }
            .expect("a reference is never null")
    }
}

fn error_text(error: &NSError) -> String {
    error.localizedDescription().to_string()
}

/// Starts recording. Blocks until the stream runs (or fails), so not on the main thread.
pub fn start(request: StartRequest) -> Result<Recorder, RecordingError> {
    if !capture::has_permission() {
        return Err(RecordingError::PermissionDenied);
    }
    let geometry = request.geometry;

    let content = capture::shareable_content()?;
    // SAFETY: plain reads of the shareable content.
    let display = unsafe { content.displays() }
        .iter()
        .find(|display| unsafe { display.displayID() } == request.display_id)
        .ok_or_else(|| {
            RecordingError::Refused("The display is no longer available. Please try again.".into())
        })?;
    // Snipvero's own windows (overlays, the indicator, the review window) stay out of the video.
    let excluded = capture::own_applications(&content);
    // SAFETY: the display and applications come from the content just fetched.
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
            SCContentFilter::alloc(),
            &display,
            &excluded,
            &NSArray::new(),
        )
    };

    // SAFETY: configuration setters on a fresh object.
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setSourceRect(CGRect::new(
            CGPoint::new(geometry.source.x, geometry.source.y),
            CGSize::new(geometry.source.width, geometry.source.height),
        ));
        config.setWidth(geometry.width as usize);
        config.setHeight(geometry.height as usize);
        config.setPixelFormat(PIXEL_FORMAT_BGRA);
        config.setQueueDepth(QUEUE_DEPTH);
        config.setMinimumFrameInterval(CMTime::new(1, request.fps as i32));
        config.setShowsCursor(true);
        if request.audio.system {
            // Delivered on the same stream; needs no permission beyond Screen Recording. Snipvero's
            // own sounds stay out of the recording (ADR-037).
            config.setCapturesAudio(true);
            config.setSampleRate(SAMPLE_RATE as isize);
            config.setChannelCount(2);
            config.setExcludesCurrentProcessAudio(true);
        }
    }

    let url =
        NSURL::fileURLWithPath(&NSString::from_str(request.output.to_str().ok_or_else(
            || RecordingError::Failed("the recording path is not valid UTF-8".into()),
        )?));
    // SAFETY: immutable framework constants and a fresh writer.
    let (file_type, media_type) = unsafe {
        (
            constant(AVFileTypeMPEG4, "AVFileTypeMPEG4")?,
            constant(AVMediaTypeVideo, "AVMediaTypeVideo")?,
        )
    };
    let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, file_type) }
        .map_err(|error| RecordingError::Failed(error_text(&error)))?;
    let settings = video_settings(
        geometry.width,
        geometry.height,
        request.bitrate,
        request.fps,
    )?;
    let input = unsafe {
        AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(
            media_type,
            Some(&settings),
        )
    };
    unsafe {
        input.setExpectsMediaDataInRealTime(true);
        if !writer.canAddInput(&input) {
            return Err(RecordingError::Failed(
                "the video encoder does not accept these settings".into(),
            ));
        }
        writer.addInput(&input);
    }
    let audio_input = if request.audio.any() {
        // SAFETY: immutable framework constant and a fresh input.
        let media = unsafe { constant(AVMediaTypeAudio, "AVMediaTypeAudio")? };
        let input = unsafe {
            AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(
                media,
                Some(&audio::aac_settings()),
            )
        };
        unsafe {
            input.setExpectsMediaDataInRealTime(true);
            if !writer.canAddInput(&input) {
                return Err(RecordingError::Failed(
                    "the audio encoder does not accept these settings".into(),
                ));
            }
            writer.addInput(&input);
        }
        Some(input)
    } else {
        None
    };
    unsafe {
        if !writer.startWriting() {
            return Err(RecordingError::Failed(writer.error().map_or_else(
                || "the video file could not be opened".into(),
                |error| error_text(&error),
            )));
        }
    }

    let shared = Arc::new(Shared {
        writer,
        input,
        state: Mutex::new(WriterState::default()),
        on_failure: request.on_failure,
        audio: audio_input.map(|input| {
            Arc::new(Pipeline::new(
                input,
                request.audio.system,
                request.audio.microphone,
            ))
        }),
    });
    let handler = StreamHandler::new(shared.clone());
    let queue = DispatchQueue::new("com.snipvero.app.recording", DispatchQueueAttr::SERIAL);
    // SAFETY: the handler implements both protocols and outlives the stream (`Native` holds it).
    let stream = unsafe {
        SCStream::initWithFilter_configuration_delegate(
            SCStream::alloc(),
            &filter,
            &config,
            Some(ProtocolObject::from_ref(&*handler)),
        )
    };
    unsafe {
        stream.addStreamOutput_type_sampleHandlerQueue_error(
            ProtocolObject::from_ref(&*handler),
            SCStreamOutputType::Screen,
            Some(&queue),
        )
    }
    .map_err(|error| RecordingError::Failed(error_text(&error)))?;
    if request.audio.system {
        // SAFETY: as above.
        unsafe {
            stream.addStreamOutput_type_sampleHandlerQueue_error(
                ProtocolObject::from_ref(&*handler),
                SCStreamOutputType::Audio,
                Some(&queue),
            )
        }
        .map_err(|error| RecordingError::Failed(error_text(&error)))?;
    }

    // The microphone first, so its first buffers are there before the first picture.
    let microphone = match (request.audio.microphone, &shared.audio) {
        (true, Some(audio)) => match Microphone::start(audio.clone()) {
            Ok(microphone) => Some(microphone),
            Err(error) => {
                // SAFETY: nothing was appended; the file is thrown away.
                unsafe { shared.writer.cancelWriting() };
                return Err(error);
            }
        },
        _ => None,
    };
    let native = Native {
        stream,
        shared,
        _handler: handler,
        _queue: queue,
        microphone,
    };
    let (done, wait) = mpsc::channel();
    let handler = RcBlock::new(move |error: *mut NSError| {
        // SAFETY: SCK passes nil or a valid error for the call.
        let _ = done.send(unsafe { error.as_ref() }.map(error_text));
    });
    // SAFETY: the handler block is copied by the framework.
    unsafe {
        native
            .stream
            .startCaptureWithCompletionHandler(Some(&handler))
    };
    match wait.recv_timeout(START_TIMEOUT) {
        Ok(None) => {
            spawn_audio_pacer(&native.shared);
            Ok(Recorder { native })
        }
        Ok(Some(reason)) => {
            native.discard();
            Err(start_failure(&reason))
        }
        Err(_) => {
            native.discard();
            Err(RecordingError::Failed(
                "timed out starting the capture".into(),
            ))
        }
    }
}

/// The user declining Screen Recording is the common reason a stream does not start.
fn start_failure(reason: &str) -> RecordingError {
    if reason.to_lowercase().contains("declined") {
        RecordingError::PermissionDenied
    } else {
        RecordingError::Failed(reason.to_string())
    }
}

/// Feeds the mixed audio to the encoder every `AUDIO_PACE`, up to a little before now on the host
/// clock, until the recording ends. Silent stretches reach the file as silence, so the audio is
/// as long as the video even when no source delivers.
fn spawn_audio_pacer(shared: &Arc<Shared>) {
    if shared.audio.is_none() {
        return;
    }
    let shared = shared.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(AUDIO_PACE);
            {
                let state = shared.state();
                if state.closed || state.failed {
                    return;
                }
            }
            shared.pump_audio(audio::host_frames() - LATENCY_FRAMES);
        }
    });
}

impl Native {
    /// Stops the stream, waiting a moment for the system to confirm. An error is expected when it
    /// already stopped by itself.
    fn stop_stream(&self) {
        let (done, wait) = mpsc::channel();
        let handler = RcBlock::new(move |_error: *mut NSError| {
            let _ = done.send(());
        });
        // SAFETY: the handler block is copied by the framework.
        unsafe { self.stream.stopCaptureWithCompletionHandler(Some(&handler)) };
        let _ = wait.recv_timeout(STOP_TIMEOUT);
    }

    /// Ends the stream and throws the file away.
    fn discard(&self) {
        if let Some(microphone) = &self.microphone {
            microphone.stop();
        }
        self.stop_stream();
        self.shared.state().closed = true;
        // SAFETY: no frame is appended any more.
        unsafe { self.shared.writer.cancelWriting() };
    }
}

impl Recorder {
    /// Ends the recording and finishes the MP4, so it plays. Blocks.
    pub fn stop(self) -> Result<Finalized, RecordingError> {
        let native = self.native;
        if let Some(microphone) = &native.microphone {
            microphone.stop();
        }
        native.stop_stream();
        let shared = &native.shared;
        let (first, last) = {
            let mut state = shared.state();
            state.closed = true;
            (state.first, state.last)
        };
        let (Some(first), Some(last)) = (first, last) else {
            // SAFETY: no frame is appended any more.
            unsafe { shared.writer.cancelWriting() };
            return Err(RecordingError::NoFrames);
        };
        // A screen that stopped changing delivers no frames, so the last frame is held until now:
        // the video is as long as the recording was.
        // SAFETY: the host clock is the clock of the stream's timestamps.
        let end = unsafe { CMClock::host_time_clock().time() };
        let end = if unsafe { end.seconds() } > unsafe { last.seconds() } {
            end
        } else {
            last
        };
        hold_last_picture(shared, last, end);
        // The rest of the audio, up to the end of the video; the capture is stopped, so nothing
        // more arrives, and the pacer no longer appends once `closed` is set.
        let mut audio_failure = None;
        if let Some(audio) = &shared.audio {
            // SAFETY: plain arithmetic on a valid time.
            let end_frames = super::mixer::frames_from_time(end.value, end.timescale);
            if let Some(block) = end_frames.and_then(|until| audio.take(until))
                && let Err(reason) = audio.append(&block)
            {
                audio_failure = Some(reason);
            }
            audio.log_summary();
        }
        // SAFETY: the stream is stopped, so nothing else touches the writer.
        unsafe {
            shared.writer.endSessionAtSourceTime(end);
            shared.input.markAsFinished();
            if let Some(audio) = &shared.audio {
                audio.input.markAsFinished();
            }
        }
        let (done, wait) = mpsc::channel();
        let handler = RcBlock::new(move || {
            let _ = done.send(());
        });
        // SAFETY: the handler block is copied by the framework.
        unsafe { shared.writer.finishWritingWithCompletionHandler(&handler) };
        if wait.recv_timeout(FINISH_TIMEOUT).is_err() {
            return Err(RecordingError::Failed(
                "timed out finishing the video file".into(),
            ));
        }
        // SAFETY: a plain property read.
        if unsafe { shared.writer.status() } != AVAssetWriterStatus::Completed {
            return Err(RecordingError::Failed(shared.writer_error()));
        }
        let (frames, dropped) = {
            let state = shared.state();
            (state.frames, state.dropped)
        };
        // SAFETY: plain arithmetic on valid times.
        let seconds = unsafe { end.seconds() - first.seconds() };
        eprintln!("[recording] {frames} frames written, {dropped} dropped, {seconds:.1} s");
        let mut notices = shared.audio.as_ref().map_or_else(Vec::new, |a| a.notices());
        notices.extend(
            audio_failure.map(|reason| format!("The sound could not be completed: {reason}.")),
        );
        Ok(Finalized {
            duration: Duration::from_secs_f64(seconds.max(0.0)),
            notices,
        })
    }

    /// Ends the recording and discards what was written. Blocks briefly; used when the app quits.
    pub fn cancel(self) {
        self.native.discard();
    }
}

/// Holds the newest picture until the end of the recording, so a screen that stopped changing
/// stays on screen for as long as the sound plays.
///
/// Measured (ADR-037): with an audio track present, `endSessionAtSourceTime` no longer stretches
/// the last picture to the end of the session, and the video track of a recording of a still screen
/// ended after one frame while the sound went on. The newest picture is appended once more,
/// stamped one frame interval before the end. Only done with sound; without it the writer already
/// stretches the last picture (measured as well).
fn hold_last_picture(shared: &Shared, last: CMTime, end: CMTime) {
    let held = shared.state().held.take();
    let Some(held) = held else { return };
    // One frame interval, in the end time's own timescale.
    let interval = i64::from(end.timescale / 30).max(1);
    // SAFETY: plain arithmetic on valid times.
    let stamp = unsafe { CMTime::new(end.value - interval, end.timescale) };
    if unsafe { stamp.seconds() <= last.seconds() } {
        return; // The last picture is recent enough: nothing to stretch.
    }
    let timing = CMSampleTimingInfo {
        duration: unsafe { CMTime::new(interval, end.timescale) },
        presentationTimeStamp: stamp,
        decodeTimeStamp: unsafe { kCMTimeInvalid },
    };
    let mut copy: *mut CMSampleBuffer = ptr::null_mut();
    // SAFETY: valid sample and timing; the out pointer is valid.
    let status = unsafe {
        CMSampleBuffer::create_copy_with_new_timing(
            None,
            &held,
            1,
            &timing,
            NonNull::from(&mut copy),
        )
    };
    let Some(copy) = NonNull::new(copy).filter(|_| status == 0) else {
        eprintln!("[recording] could not hold the last picture ({status})");
        return;
    };
    // SAFETY: a +1 reference returned by a Create function.
    let copy: CFRetained<CMSampleBuffer> = unsafe { CFRetained::from_raw(copy) };
    // SAFETY: the stream is stopped, so nothing else touches the input.
    if unsafe { shared.input.isReadyForMoreMediaData() }
        && unsafe { shared.input.appendSampleBuffer(&copy) }
    {
        eprintln!("[recording] held the last picture until the end");
    }
}

/// Free space for important data on the volume of `path`, as Finder would report it.
pub fn available_space(path: &Path) -> Option<u64> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
    // SAFETY: an immutable framework constant.
    let key = unsafe { NSURLVolumeAvailableCapacityForImportantUsageKey };
    let values = url
        .resourceValuesForKeys_error(&NSArray::from_slice(&[key]))
        .ok()?;
    let value = values.objectForKey(key)?;
    let bytes = value.downcast_ref::<NSNumber>()?.longLongValue();
    u64::try_from(bytes).ok()
}

/// The file itself on the clipboard, so Finder pastes a copy of it.
pub fn copy_file(path: &Path) -> Result<(), String> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(
        path.to_str()
            .ok_or("the recording path is not valid UTF-8")?,
    ));
    write_pasteboard(ProtocolObject::from_retained(url))
}

pub fn copy_text(text: &str) -> Result<(), String> {
    write_pasteboard(ProtocolObject::from_retained(NSString::from_str(text)))
}

fn write_pasteboard(item: Retained<ProtocolObject<dyn NSPasteboardWriting>>) -> Result<(), String> {
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if pasteboard.writeObjects(&NSArray::from_retained_slice(&[item])) {
        Ok(())
    } else {
        Err("the clipboard refused it".into())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::super::AudioChoice;
    use super::*;
    use crate::geometry::{LogicalRect, RecordingGeometry};

    /// Records two seconds of a corner of the first display through the real ScreenCaptureKit and
    /// AVAssetWriter path and checks the MP4 is complete. It needs the Screen Recording permission
    /// of whatever runs the tests (a terminal), so it only runs on request:
    /// `cargo test -- --ignored records_a_region`.
    #[test]
    #[ignore = "needs the Screen Recording permission"]
    fn records_a_region_to_a_finished_mp4() {
        let (frames, _) = capture::capture_displays().expect("capture permission and a display");
        let display_id = frames.first().expect("a display").display_id;
        let dir = std::env::temp_dir().join(format!("snipvero-record-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("test.mp4");
        let failed = Arc::new(AtomicBool::new(false));
        let flag = failed.clone();
        // x,y,width,height in display points, which are also the output pixels here:
        // SNIPVERO_TEST_REGION=200,200,300,200 to line the region up with a known window.
        let [x, y, width, height] = std::env::var("SNIPVERO_TEST_REGION")
            .ok()
            .and_then(|v| {
                v.split(',')
                    .map(|n| n.parse::<f64>().ok())
                    .collect::<Option<Vec<_>>>()?
                    .try_into()
                    .ok()
            })
            .unwrap_or([40.0, 40.0, 320.0, 240.0]);
        let recorder = start(StartRequest {
            display_id,
            geometry: RecordingGeometry {
                source: LogicalRect {
                    x,
                    y,
                    width,
                    height,
                },
                width: width as u32,
                height: height as u32,
            },
            bitrate: 2_000_000,
            fps: 30,
            output: output.clone(),
            // SNIPVERO_TEST_AUDIO=system, =microphone or =system,microphone; silent by default.
            audio: {
                let list = std::env::var("SNIPVERO_TEST_AUDIO").unwrap_or_default();
                AudioChoice {
                    system: list.split(',').any(|name| name == "system"),
                    microphone: list.split(',').any(|name| name == "microphone"),
                }
            },
            on_failure: Arc::new(move |_| flag.store(true, Ordering::SeqCst)),
        })
        .expect("the stream starts");
        // SNIPVERO_TEST_SECONDS lengthens it, for sync checks.
        let seconds = std::env::var("SNIPVERO_TEST_SECONDS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2);
        std::thread::sleep(Duration::from_secs(seconds));
        let finalized = recorder.stop().expect("the file is finalized");
        assert!(!failed.load(Ordering::SeqCst));
        // The screen may be static, so the length is the recording's, not the frame count's.
        assert!(
            finalized.duration >= Duration::from_millis(1500),
            "{:?}",
            finalized.duration
        );
        let bytes = std::fs::read(&output).unwrap();
        assert!(bytes.len() > 1000);
        assert_eq!(&bytes[4..8], b"ftyp");
        assert!(
            bytes.windows(4).any(|w| w == b"moov"),
            "no moov atom: unplayable"
        );
        println!("recorded {} bytes, {:?}", bytes.len(), finalized.duration);
        // For looking at the result with other tools: SNIPVERO_KEEP_RECORDING=/tmp/out.mp4.
        if let Some(keep) = std::env::var_os("SNIPVERO_KEEP_RECORDING") {
            std::fs::copy(&output, keep).unwrap();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
