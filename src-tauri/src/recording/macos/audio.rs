//! Audio of a macOS recording (ADR-037): system audio arrives from the same `SCStream` as the
//! pictures, the microphone from an `AVCaptureSession`. Both are decoded to stereo `f32`, mixed
//! by the pure `mixer` module, and appended to one AAC input of the `AVAssetWriter`.
//!
//! Nothing here is created unless a source is switched on: with both off there is no capture
//! session, no `AVCaptureDevice` call and no permission lookup (ADR-037).

use std::ffi::c_void;
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchQueueAttr, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, define_class, msg_send};
use objc2_av_foundation::{
    AVAssetWriterInput, AVAuthorizationStatus, AVCaptureAudioDataOutput,
    AVCaptureAudioDataOutputSampleBufferDelegate, AVCaptureConnection, AVCaptureDevice,
    AVCaptureDeviceInput, AVCaptureOutput, AVCaptureSession,
    AVCaptureSessionRuntimeErrorNotification, AVMediaTypeAudio,
};
use objc2_core_audio_types::{
    AudioBuffer, AudioBufferList, AudioStreamBasicDescription, kAudioFormatFlagIsFloat,
    kAudioFormatFlagIsNonInterleaved, kAudioFormatFlagIsPacked, kAudioFormatFlagIsSignedInteger,
    kAudioFormatLinearPCM, kAudioFormatMPEG4AAC,
};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{
    CMAudioFormatDescriptionCreate, CMAudioFormatDescriptionGetStreamBasicDescription,
    CMAudioSampleBufferCreateReadyWithPacketDescriptions, CMBlockBuffer, CMClock,
    CMFormatDescription, CMSampleBuffer, CMTime, kCMBlockBufferAssureMemoryNowFlag,
};
use objc2_foundation::{
    NSDictionary, NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSString,
};

use super::super::mixer::{
    Block, CHANNELS, Encoding, Format, Mixer, Resampler, SAMPLE_RATE, Source, clock_correction,
    frames_from_time, to_stereo,
};
use super::super::{MicrophoneAccess, RecordingError};
use super::{error_text, number};
use crate::i18n::tr;

/// The AAC track: 48 kHz stereo at 128 kbit/s (ADR-037).
const AAC_BITRATE: u32 = 128_000;
/// How long the mixer waits for a source before it calls the gap silence. The measured delivery
/// latency of system audio is under 100 ms (ADR-037); the microphone is faster.
pub const LATENCY_FRAMES: i64 = SAMPLE_RATE as i64 / 4;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// The host clock, in frames of the output: the clock the pictures and both audio sources are
/// stamped with.
pub fn host_frames() -> i64 {
    // SAFETY: the host clock always exists.
    let now = unsafe { CMClock::host_time_clock().time() };
    frames_from_time(now.value, now.timescale).unwrap_or(0)
}

fn slot(source: Source) -> usize {
    match source {
        Source::System => 0,
        Source::Microphone => 1,
    }
}

fn name(source: Source) -> &'static str {
    match source {
        Source::System => "system audio",
        Source::Microphone => "microphone",
    }
}

/// What one source has delivered so far.
#[derive(Default)]
struct Track {
    /// Whether this source was switched on for the recording.
    enabled: bool,
    resampler: Option<Resampler>,
    rate: u32,
    /// Shift of this source's timestamps onto the host clock, decided by the first buffer.
    correction: Option<i64>,
    buffers: u64,
    /// Buffers that could not be read, and why (the first reason).
    rejected: u64,
    problem: Option<String>,
}

struct Inner {
    mixer: Mixer,
    tracks: [Track; 2],
}

/// The audio half of a recording: the mixer, the AAC input and what to tell the user at the end.
pub struct Pipeline {
    pub input: Retained<AVAssetWriterInput>,
    inner: Mutex<Inner>,
    /// Frames appended to the writer, and frames the encoder was too busy to take.
    appended: AtomicU64,
    dropped: AtomicU64,
}

// SAFETY: `input` is only used by `append`, which the owner calls while holding the writer's
// state lock, and `mark_finished` after that lock made the pipeline unreachable for appends; the
// mixer is behind its own mutex.
unsafe impl Send for Pipeline {}
unsafe impl Sync for Pipeline {}

impl Pipeline {
    pub fn new(input: Retained<AVAssetWriterInput>, system: bool, microphone: bool) -> Self {
        let mut tracks = [Track::default(), Track::default()];
        tracks[slot(Source::System)].enabled = system;
        tracks[slot(Source::Microphone)].enabled = microphone;
        Pipeline {
            input,
            inner: Mutex::new(Inner {
                mixer: Mixer::new(),
                tracks,
            }),
            appended: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        }
    }

    /// The recording's first picture has this timestamp: audio starts there.
    pub fn start(&self, first_picture: CMTime) {
        if let Some(origin) = frames_from_time(first_picture.value, first_picture.timescale) {
            lock(&self.inner).mixer.start(origin);
        }
    }

    /// Reads one audio sample buffer of `source` into the mixer. Called on the source's own queue.
    pub fn ingest(&self, source: Source, sample: &CMSampleBuffer) {
        // SAFETY: plain reads of a valid sample buffer.
        if !unsafe { sample.is_valid() && sample.data_is_ready() && sample.num_samples() > 0 } {
            return;
        }
        let decoded = read_pcm(sample);
        // SAFETY: as above.
        let stamp = unsafe { sample.presentation_time_stamp() };
        let mut inner = lock(&self.inner);
        let track = &mut inner.tracks[slot(source)];
        let (rate, stereo) = match decoded {
            Ok(decoded) => decoded,
            Err(reason) => {
                track.rejected += 1;
                if track.problem.is_none() {
                    eprintln!("[recording] {} buffer rejected: {reason}", name(source));
                    track.problem = Some(reason);
                }
                return;
            }
        };
        if track.resampler.is_none() || track.rate != rate {
            track.resampler = Resampler::new(rate);
            track.rate = rate;
        }
        let samples = match track.resampler.as_mut() {
            Some(resampler) => resampler.process(&stereo),
            None => return,
        };
        let Some(start) = frames_from_time(stamp.value, stamp.timescale) else {
            return;
        };
        let frames = (samples.len() / CHANNELS) as i64;
        let correction = *track.correction.get_or_insert_with(|| {
            let now = host_frames();
            let correction = clock_correction(start + frames, now);
            eprintln!(
                "[recording] {} first buffer: {rate} Hz, {frames} frames, arrived {:.0} ms after it ended, \
                 {} the host clock",
                name(source),
                (now - (start + frames)) as f64 * 1000.0 / f64::from(SAMPLE_RATE),
                if correction == 0 {
                    "stamped on".to_string()
                } else {
                    format!("shifted by {correction} frames onto")
                }
            );
            correction
        });
        track.buffers += 1;
        inner.mixer.push(source, start + correction, &samples);
    }

    /// Notes something that went wrong with `source` while recording, for the notice at the end.
    pub fn note_problem(&self, source: Source, problem: String) {
        let mut inner = lock(&self.inner);
        let track = &mut inner.tracks[slot(source)];
        if track.problem.is_none() {
            eprintln!("[recording] {}: {problem}", name(source));
            track.problem = Some(problem);
        }
    }

    /// What the mixer has ready before `until`, as a PCM sample buffer for the writer.
    pub fn take(&self, until: i64) -> Option<Block> {
        lock(&self.inner).mixer.drain_until(until)
    }

    /// Appends one block to the AAC input. `Ok(false)`: the encoder did not take it (busy);
    /// `Err`: it failed. The caller holds the writer's state lock.
    pub fn append(&self, block: &Block) -> Result<bool, String> {
        let sample = pcm_sample_buffer(block)?;
        // SAFETY: the caller serializes appends; the input is not finished yet.
        if !unsafe { self.input.isReadyForMoreMediaData() } {
            self.dropped
                .fetch_add(block.frames() as u64, Ordering::Relaxed);
            return Ok(false);
        }
        // SAFETY: as above.
        if unsafe { self.input.appendSampleBuffer(&sample) } {
            self.appended
                .fetch_add(block.frames() as u64, Ordering::Relaxed);
            Ok(true)
        } else {
            Err(tr!("the audio encoder stopped", "ses kodlayıcı durdu").into())
        }
    }

    pub fn log_summary(&self) {
        let inner = lock(&self.inner);
        let describe = |source: Source| {
            let track = &inner.tracks[slot(source)];
            if track.enabled {
                format!("{} buffers ({} rejected)", track.buffers, track.rejected)
            } else {
                "off".to_string()
            }
        };
        eprintln!(
            "[recording] audio: system {}, microphone {}; {} frames written, {} dropped",
            describe(Source::System),
            describe(Source::Microphone),
            self.appended.load(Ordering::Relaxed),
            self.dropped.load(Ordering::Relaxed)
        );
    }

    /// What to tell the user about the audio of the finished recording: nothing when it went well.
    pub fn notices(&self) -> Vec<String> {
        let inner = lock(&self.inner);
        let mut notices = Vec::new();
        for source in [Source::System, Source::Microphone] {
            let track = &inner.tracks[slot(source)];
            if !track.enabled {
                continue;
            }
            let label = match source {
                Source::System => tr!("System audio", "Sistem sesi"),
                Source::Microphone => tr!("Microphone audio", "Mikrofon sesi"),
            };
            if let Some(problem) = &track.problem {
                notices.push(tr!(
                    format!("{label} stopped being recorded: {problem}."),
                    format!("{label} kaydı durdu: {problem}.")
                ));
            } else if track.buffers == 0 {
                notices.push(match source {
                    Source::System => tr!(
                        "No system audio was received, so that part of the sound is missing.",
                        "Sistem sesi alınamadı, bu nedenle sesin o kısmı eksik."
                    )
                    .into(),
                    Source::Microphone => tr!(
                        "No microphone audio was received, so the recording has no microphone sound. \
                         Check Snipvero's access under System Settings → Privacy & Security → Microphone.",
                        "Mikrofon sesi alınamadı, bu nedenle kayıtta mikrofon sesi yok. \
                         Sistem Ayarları → Gizlilik ve Güvenlik → Mikrofon bölümünde Snipvero'nun erişimini kontrol edin."
                    )
                    .into(),
                });
            }
        }
        let dropped = self.dropped.load(Ordering::Relaxed);
        if dropped > u64::from(SAMPLE_RATE) / 2 {
            notices.push(
                tr!(
                    "The sound has short gaps: the computer was too busy to encode all of it.",
                    "Seste kısa kesintiler var: bilgisayar sesin tamamını kodlayamayacak kadar meşguldü."
                )
                .into(),
            );
        }
        notices
    }
}

/// The settings of the AAC input. The keys are the documented string values of `AVFormatIDKey`,
/// `AVSampleRateKey`, `AVNumberOfChannelsKey` and `AVEncoderBitRateKey` (AVFAudio, which has no
/// bindings in the tree; the constants are plain strings).
pub fn aac_settings() -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys = [
        NSString::from_str("AVFormatIDKey"),
        NSString::from_str("AVSampleRateKey"),
        NSString::from_str("AVNumberOfChannelsKey"),
        NSString::from_str("AVEncoderBitRateKey"),
    ];
    let values = [
        number(kAudioFormatMPEG4AAC),
        number(SAMPLE_RATE),
        number(CHANNELS as u32),
        number(AAC_BITRATE),
    ];
    let key_refs: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
    NSDictionary::from_retained_objects(&key_refs, &values)
}

/// Linear PCM: 32-bit float, interleaved stereo at the output rate. What the mixer hands out.
fn output_description() -> AudioStreamBasicDescription {
    AudioStreamBasicDescription {
        mSampleRate: f64::from(SAMPLE_RATE),
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: (CHANNELS * 4) as u32,
        mFramesPerPacket: 1,
        mBytesPerFrame: (CHANNELS * 4) as u32,
        mChannelsPerFrame: CHANNELS as u32,
        mBitsPerChannel: 32,
        mReserved: 0,
    }
}

/// Wraps a mixed block in a `CMSampleBuffer` stamped with its position on the host clock.
fn pcm_sample_buffer(block: &Block) -> Result<CFRetained<CMSampleBuffer>, String> {
    let status_text = |what: &str, status: i32| format!("{what} failed ({status})");
    let frames = block.frames();
    let bytes = frames * CHANNELS * 4;
    let mut description = output_description();

    let mut format: *const CMFormatDescription = ptr::null();
    // SAFETY: valid in/out pointers; the description outlives the call.
    let status = unsafe {
        CMAudioFormatDescriptionCreate(
            None,
            NonNull::from(&mut description),
            0,
            ptr::null(),
            0,
            ptr::null(),
            None,
            NonNull::from(&mut format),
        )
    };
    let format = NonNull::new(format.cast_mut())
        .filter(|_| status == 0)
        .ok_or_else(|| status_text("creating the audio format", status))?;
    // SAFETY: a +1 reference returned by a Create function.
    let format: CFRetained<CMFormatDescription> = unsafe { CFRetained::from_raw(format) };

    let mut buffer: *mut CMBlockBuffer = ptr::null_mut();
    // SAFETY: a block buffer that allocates `bytes` itself; the out pointer is valid.
    let status = unsafe {
        CMBlockBuffer::create_with_memory_block(
            None,
            ptr::null_mut(),
            bytes,
            None,
            ptr::null(),
            0,
            bytes,
            kCMBlockBufferAssureMemoryNowFlag,
            NonNull::from(&mut buffer),
        )
    };
    let buffer = NonNull::new(buffer)
        .filter(|_| status == 0)
        .ok_or_else(|| status_text("allocating audio memory", status))?;
    // SAFETY: a +1 reference returned by a Create function.
    let buffer: CFRetained<CMBlockBuffer> = unsafe { CFRetained::from_raw(buffer) };
    // SAFETY: `samples` holds exactly `bytes` bytes and the buffer was created with that size.
    let status = unsafe {
        CMBlockBuffer::replace_data_bytes(
            NonNull::new(block.samples.as_ptr().cast_mut().cast::<c_void>())
                .ok_or("empty audio block")?,
            &buffer,
            0,
            bytes,
        )
    };
    if status != 0 {
        return Err(status_text("copying audio", status));
    }

    let mut sample: *mut CMSampleBuffer = ptr::null_mut();
    // SAFETY: valid objects and out pointer; linear PCM needs no packet descriptions.
    let status = unsafe {
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            None,
            &buffer,
            &format,
            frames as isize,
            CMTime::new(block.start, SAMPLE_RATE as i32),
            ptr::null(),
            NonNull::from(&mut sample),
        )
    };
    let sample = NonNull::new(sample)
        .filter(|_| status == 0)
        .ok_or_else(|| status_text("creating the audio sample", status))?;
    // SAFETY: a +1 reference returned by a Create function.
    Ok(unsafe { CFRetained::from_raw(sample) })
}

/// The samples of one audio buffer as interleaved stereo `f32`, with the rate they are at.
fn read_pcm(sample: &CMSampleBuffer) -> Result<(u32, Vec<f32>), String> {
    // SAFETY: plain reads of a valid sample buffer.
    let description = unsafe { sample.format_description() }.ok_or("no audio format")?;
    // SAFETY: the pointer is valid while `description` lives; null for a non-audio format.
    let asbd = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&description).as_ref() }
        .ok_or("not an audio format")?;
    if asbd.mFormatID != kAudioFormatLinearPCM {
        return Err("the audio is not PCM".into());
    }
    let flags = asbd.mFormatFlags;
    let encoding = match (
        flags & kAudioFormatFlagIsFloat != 0,
        asbd.mBitsPerChannel,
        flags & kAudioFormatFlagIsSignedInteger != 0,
    ) {
        (true, 32, _) => Encoding::Float32,
        (false, 16, true) => Encoding::Int16,
        (_, bits, _) => return Err(format!("{bits}-bit audio is not supported")),
    };
    // 0x2 is the big-endian flag; every Mac we support is little-endian.
    if flags & 0x2 != 0 {
        return Err("big-endian audio is not supported".into());
    }
    let channels = asbd.mChannelsPerFrame as usize;
    let rate = asbd.mSampleRate.round();
    if channels == 0 || rate < 1.0 {
        return Err("the audio format is empty".into());
    }
    let format = Format {
        sample_rate: rate as u32,
        channels,
        encoding,
        planar: flags & kAudioFormatFlagIsNonInterleaved != 0,
    };
    // SAFETY: plain read.
    let frames = unsafe { sample.num_samples() } as usize;
    let plane_count = if format.planar { channels } else { 1 };
    let plane_bytes = frames * encoding.bytes() * if format.planar { 1 } else { channels };

    // An AudioBufferList has a variable number of trailing buffers; 8-byte aligned backing memory.
    let list_bytes = size_of::<AudioBufferList>() + (plane_count - 1) * size_of::<AudioBuffer>();
    let mut list_memory = vec![0_u64; list_bytes.div_ceil(8)];
    let list = list_memory.as_mut_ptr().cast::<AudioBufferList>();
    let mut planes: Vec<Vec<u8>> = (0..plane_count).map(|_| vec![0_u8; plane_bytes]).collect();
    // SAFETY: `list_memory` is large and aligned enough for `plane_count` buffers, each pointing
    // at its own plane, which outlives the copy below.
    unsafe {
        (*list).mNumberBuffers = plane_count as u32;
        let buffers = (*list).mBuffers.as_mut_ptr();
        for (index, plane) in planes.iter_mut().enumerate() {
            *buffers.add(index) = AudioBuffer {
                mNumberChannels: if format.planar { 1 } else { channels as u32 },
                mDataByteSize: plane_bytes as u32,
                mData: plane.as_mut_ptr().cast(),
            };
        }
    }
    // SAFETY: `list` is valid for the call and describes writable memory.
    let status = unsafe {
        sample.copy_pcm_data_into_audio_buffer_list(
            0,
            frames as i32,
            NonNull::new(list).ok_or("no audio list")?,
        )
    };
    if status != 0 {
        return Err(format!("reading the audio failed ({status})"));
    }
    let views: Vec<&[u8]> = planes.iter().map(Vec::as_slice).collect();
    let stereo = to_stereo(&format, &views).map_err(|e| format!("unreadable audio ({e:?})"))?;
    Ok((format.sample_rate, stereo))
}

// ---- Microphone -------------------------------------------------------------------------------

/// The microphone permission, as the system reports it right now. Never prompts.
pub fn microphone_access() -> MicrophoneAccess {
    let Some(media) = (unsafe { AVMediaTypeAudio }) else {
        return MicrophoneAccess::Unsupported;
    };
    // SAFETY: a plain class method with an immutable constant.
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) } {
        AVAuthorizationStatus::Authorized => MicrophoneAccess::Authorized,
        AVAuthorizationStatus::Denied => MicrophoneAccess::Denied,
        AVAuthorizationStatus::Restricted => MicrophoneAccess::Restricted,
        _ => MicrophoneAccess::NotDetermined,
    }
}

/// Asks the system for the microphone (the prompt appears only while the status is "not
/// determined"). `done` is called once, from a system thread, with whether it was granted.
pub fn request_microphone_access(done: Box<dyn FnOnce(bool) + Send>) {
    let Some(media) = (unsafe { AVMediaTypeAudio }) else {
        done(false);
        return;
    };
    let done = Mutex::new(Some(done));
    let handler = RcBlock::new(move |granted: objc2::runtime::Bool| {
        if let Some(done) = lock(&done).take() {
            done(granted.as_bool());
        }
    });
    // SAFETY: the block is copied by the framework.
    unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &handler) };
}

struct HandlerIvars {
    pipeline: Arc<Pipeline>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this class has no Drop.
    #[unsafe(super(NSObject))]
    #[ivars = HandlerIvars]
    struct MicrophoneHandler;

    unsafe impl NSObjectProtocol for MicrophoneHandler {}

    unsafe impl AVCaptureAudioDataOutputSampleBufferDelegate for MicrophoneHandler {
        #[unsafe(method(captureOutput:didOutputSampleBuffer:fromConnection:))]
        fn capture_output(
            &self,
            _output: &AVCaptureOutput,
            sample: &CMSampleBuffer,
            _connection: &AVCaptureConnection,
        ) {
            self.ivars().pipeline.ingest(Source::Microphone, sample);
        }
    }
);

impl MicrophoneHandler {
    fn new(pipeline: Arc<Pipeline>) -> Retained<Self> {
        let handler = Self::alloc().set_ivars(HandlerIvars { pipeline });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(handler), init] }
    }
}

/// The running microphone capture.
pub struct Microphone {
    session: Retained<AVCaptureSession>,
    observer: Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    // Kept alive: the output holds its delegate weakly.
    _handler: Retained<MicrophoneHandler>,
    _output: Retained<AVCaptureAudioDataOutput>,
    _queue: DispatchRetained<DispatchQueue>,
}

// SAFETY: AVCaptureSession is documented as usable from any thread; the recorder owns this and
// starts and stops it from one thread at a time.
unsafe impl Send for Microphone {}

impl Microphone {
    /// Starts capturing the default input. Blocks until the session runs, so not on the main thread.
    /// The caller checked the permission; this fails with a message when the capture cannot start.
    pub fn start(pipeline: Arc<Pipeline>) -> Result<Microphone, RecordingError> {
        let media = unsafe { AVMediaTypeAudio }
            .ok_or_else(|| RecordingError::Failed("AVFoundation has no audio media type".into()))?;
        // SAFETY: plain class method.
        let device =
            unsafe { AVCaptureDevice::defaultDeviceWithMediaType(media) }.ok_or_else(|| {
                RecordingError::Refused(
                    tr!(
                        "No microphone was found. Connect one, or turn the microphone off.",
                        "Mikrofon bulunamadı. Bir mikrofon bağlayın veya mikrofonu kapatın."
                    )
                    .into(),
                )
            })?;
        // SAFETY: a fresh input for an existing device.
        let input = unsafe { AVCaptureDeviceInput::deviceInputWithDevice_error(&device) }.map_err(
            |error| RecordingError::Failed(format!("microphone: {}", error_text(&error))),
        )?;
        // SAFETY: a fresh session, output and queue configured before the session runs.
        let session = unsafe { AVCaptureSession::new() };
        let output = unsafe { AVCaptureAudioDataOutput::new() };
        let queue = DispatchQueue::new(
            "com.snipvero.app.recording.microphone",
            DispatchQueueAttr::SERIAL,
        );
        let handler = MicrophoneHandler::new(pipeline.clone());
        unsafe {
            if !session.canAddInput(&input) || !session.canAddOutput(&output) {
                return Err(RecordingError::Failed(
                    tr!(
                        "the microphone cannot be used by the recorder",
                        "mikrofon kaydedici tarafından kullanılamıyor"
                    )
                    .into(),
                ));
            }
            session.addInput(&input);
            session.addOutput(&output);
            output.setSampleBufferDelegate_queue(
                Some(ProtocolObject::from_ref(&*handler)),
                Some(&queue),
            );
        }
        let observer = observe_runtime_errors(&session, pipeline);
        // SAFETY: blocks until the session runs or fails.
        unsafe { session.startRunning() };
        // SAFETY: a plain property read.
        if !unsafe { session.isRunning() } {
            return Err(RecordingError::Failed(
                tr!(
                    "the microphone did not start. Check Snipvero's access under System Settings → Privacy & Security → Microphone.",
                    "mikrofon başlatılamadı. Sistem Ayarları → Gizlilik ve Güvenlik → Mikrofon bölümünde Snipvero'nun erişimini kontrol edin."
                )
                .into(),
            ));
        }
        Ok(Microphone {
            session,
            observer,
            _handler: handler,
            _output: output,
            _queue: queue,
        })
    }

    /// Stops capturing. No buffer reaches the mixer afterwards.
    pub fn stop(&self) {
        if let Some(observer) = &self.observer {
            // SAFETY: the observer was added to this centre.
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
        }
        // SAFETY: blocks until the session stopped.
        unsafe { self.session.stopRunning() };
    }
}

/// A runtime error of the session (the device was unplugged, access was revoked) is noted for the
/// message at the end; the recording itself goes on, with silence where the microphone was.
fn observe_runtime_errors(
    session: &AVCaptureSession,
    pipeline: Arc<Pipeline>,
) -> Option<Retained<ProtocolObject<dyn NSObjectProtocol>>> {
    let handler = RcBlock::new(move |_notification: NonNull<NSNotification>| {
        pipeline.note_problem(
            Source::Microphone,
            tr!(
                "the microphone stopped (it was unplugged or its access was turned off)",
                "mikrofon durdu (bağlantısı kesildi veya erişimi kapatıldı)"
            )
            .into(),
        );
    });
    // SAFETY: the block is copied by the framework; the notification name is a framework constant.
    Some(unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(AVCaptureSessionRuntimeErrorNotification),
            Some(&*(session as *const AVCaptureSession).cast::<AnyObject>()),
            None,
            &handler,
        )
    })
}
