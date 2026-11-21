//! Pure audio mixing for screen recordings (ADR-037): system audio and the microphone are mixed
//! into one stereo track, because players generally play only the first audio track of an MP4.
//!
//! Everything here is plain arithmetic on `f32` samples, with no platform import, so it is tested
//! on every OS. Samples are interleaved stereo at [`SAMPLE_RATE`]; times are absolute frame
//! numbers on the host clock (`frames_from_time`), the clock the video's timestamps use too.
//!
//! The mixer does not wait for a source. The caller (a pacer thread on the host clock) asks for
//! everything up to "now minus a latency" with [`Mixer::drain_until`]; whatever a source has not
//! delivered by then is silence, and data that arrives later than that is dropped. A source that
//! stalls, never starts (nothing is playing and the system sends no buffers) or only appears
//! later therefore never holds the other one back, and the track is exactly as long as the video.

use std::collections::VecDeque;

/// Output rate, and the rate both sources are converted to.
pub const SAMPLE_RATE: u32 = 48_000;
/// Interleaved stereo.
pub const CHANNELS: usize = 2;

/// Timestamps of one source that differ from the end of its previous buffer by at most this much
/// are jitter: the buffer is placed right after the previous one, so the samples stay gapless and
/// a source's own sample clock (a few tens of ppm off the host clock, about 30 ms in ten minutes)
/// is followed instead of the noisy timestamps. A larger step is a real gap or an overlap and is
/// placed by its timestamp: padded with silence, or the overlap dropped.
pub const TOLERANCE_FRAMES: i64 = SAMPLE_RATE as i64 / 10;

/// Where a buffer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    System,
    Microphone,
}

impl Source {
    const COUNT: usize = 2;

    fn index(self) -> usize {
        match self {
            Source::System => 0,
            Source::Microphone => 1,
        }
    }
}

/// Mixed audio ready for the encoder: interleaved stereo starting at frame `start`.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub start: i64,
    pub samples: Vec<f32>,
}

impl Block {
    pub fn frames(&self) -> usize {
        self.samples.len() / CHANNELS
    }
}

/// `value / timescale` seconds as a frame number at [`SAMPLE_RATE`], rounded to the nearest frame.
/// `None` for an invalid time (zero timescale).
pub fn frames_from_time(value: i64, timescale: i32) -> Option<i64> {
    if timescale <= 0 {
        return None;
    }
    let scaled = i128::from(value) * i128::from(SAMPLE_RATE);
    let scale = i128::from(timescale);
    let half = scale / 2;
    let rounded = if scaled >= 0 {
        (scaled + half) / scale
    } else {
        (scaled - half) / scale
    };
    i64::try_from(rounded).ok()
}

/// A constant correction, in frames, for a source whose timestamps are not on the host clock.
///
/// `end` is the end of the source's first buffer and `now` the host time it arrived. A buffer
/// reaches us a little after it ended (the measured system audio delivery latency is under
/// 100 ms), so a difference up to `MAX_DELIVERY_DELAY_FRAMES` means the clocks agree and nothing
/// is corrected. Otherwise the source's clock is somewhere else, and the first buffer is assumed
/// to have arrived `ASSUMED_DELAY_FRAMES` after it ended; the returned shift moves every buffer
/// of the source by the same amount, and the gapless placement does the rest.
pub fn clock_correction(end: i64, now: i64) -> i64 {
    let delay = now - end;
    if (-MAX_DELIVERY_DELAY_FRAMES..=MAX_DELIVERY_DELAY_FRAMES).contains(&delay) {
        0
    } else {
        delay - ASSUMED_DELAY_FRAMES
    }
}

const MAX_DELIVERY_DELAY_FRAMES: i64 = SAMPLE_RATE as i64; // one second
const ASSUMED_DELAY_FRAMES: i64 = SAMPLE_RATE as i64 / 20; // 50 ms

/// Keeps a sum of sources inside -1..1 without clipping the common case: identity up to 0.9, then
/// a smooth curve that approaches 1 and stays at or below it. A quiet source is unchanged.
pub fn limit(sample: f32) -> f32 {
    const KNEE: f32 = 0.9;
    if sample.is_nan() {
        return 0.0;
    }
    let magnitude = sample.abs();
    if magnitude <= KNEE {
        return sample;
    }
    let room = 1.0 - KNEE;
    let limited = (KNEE + room * ((magnitude - KNEE) / room).tanh()).min(1.0);
    limited.copysign(sample)
}

/// One chunk of a source, placed on the timeline.
#[derive(Debug)]
struct Chunk {
    start: i64,
    samples: Vec<f32>,
}

impl Chunk {
    fn end(&self) -> i64 {
        self.start + (self.samples.len() / CHANNELS) as i64
    }
}

/// What one source delivered and has not been mixed yet.
#[derive(Debug, Default)]
struct Lane {
    chunks: VecDeque<Chunk>,
    /// The end of the last buffer, once there was one; the next buffer is expected here.
    next: Option<i64>,
}

/// Mixes the sources into one stereo stream. See the module comment.
#[derive(Debug, Default)]
pub struct Mixer {
    lanes: [Lane; Source::COUNT],
    /// Everything before this frame has been handed out (or is before the recording's start).
    emitted: Option<i64>,
}

impl Mixer {
    pub fn new() -> Self {
        Mixer::default()
    }

    /// The recording begins at frame `origin` (its first video frame). Audio before it is
    /// discarded, audio after it is mixed. Call once; audio pushed earlier is kept until then.
    pub fn start(&mut self, origin: i64) {
        if self.emitted.is_some() {
            return;
        }
        self.emitted = Some(origin);
        for lane in &mut self.lanes {
            lane.trim_before(origin);
        }
    }

    /// Adds one buffer of `source`: interleaved stereo that began at frame `start`. A buffer
    /// that ends before what was already handed out is dropped.
    pub fn push(&mut self, source: Source, start: i64, samples: &[f32]) {
        let frames = (samples.len() / CHANNELS) as i64;
        if frames == 0 {
            return;
        }
        let lane = &mut self.lanes[source.index()];
        // Where the buffer sits, and how many of its leading frames repeat what we already have.
        let (position, skip) = match lane.next {
            None => (start, 0),
            Some(next) if (start - next).abs() <= TOLERANCE_FRAMES => (next, 0),
            Some(next) if start > next => (start, 0),
            Some(next) => (next, next - start),
        };
        if skip >= frames {
            return;
        }
        let kept = frames - skip;
        lane.next = Some(position + kept);
        let mut position = position;
        let mut data = &samples[skip as usize * CHANNELS..];
        // Audio that is too late for the block already handed out is of no use any more.
        if let Some(emitted) = self.emitted
            && position < emitted
        {
            let late = emitted - position;
            if late >= kept {
                return;
            }
            data = &data[late as usize * CHANNELS..];
            position = emitted;
        }
        lane.chunks.push_back(Chunk {
            start: position,
            samples: data.to_vec(),
        });
    }

    /// Hands out the mix of everything before frame `until` that has not been handed out yet,
    /// silence where a source has nothing. `None` before `start` or when there is nothing new.
    pub fn drain_until(&mut self, until: i64) -> Option<Block> {
        let from = self.emitted?;
        if until <= from {
            return None;
        }
        let frames = (until - from) as usize;
        let mut mixed = vec![0.0_f32; frames * CHANNELS];
        for lane in &mut self.lanes {
            lane.mix_into(&mut mixed, from, until);
        }
        for sample in &mut mixed {
            *sample = limit(*sample);
        }
        self.emitted = Some(until);
        Some(Block {
            start: from,
            samples: mixed,
        })
    }
}

impl Lane {
    fn trim_before(&mut self, frame: i64) {
        while let Some(front) = self.chunks.front_mut() {
            if front.end() <= frame {
                self.chunks.pop_front();
            } else {
                if front.start < frame {
                    let cut = (frame - front.start) as usize * CHANNELS;
                    front.samples.drain(..cut);
                    front.start = frame;
                }
                break;
            }
        }
    }

    /// Adds the part of this lane inside `[from, until)` to `out` (which starts at `from`) and
    /// forgets it.
    fn mix_into(&mut self, out: &mut [f32], from: i64, until: i64) {
        for chunk in &self.chunks {
            let first = chunk.start.max(from);
            let last = chunk.end().min(until);
            if first >= last {
                continue;
            }
            let source = &chunk.samples[(first - chunk.start) as usize * CHANNELS..];
            let target = &mut out[(first - from) as usize * CHANNELS..];
            let count = (last - first) as usize * CHANNELS;
            for (target, source) in target[..count].iter_mut().zip(&source[..count]) {
                *target += *source;
            }
        }
        self.trim_before(until);
    }
}

/// How samples of one buffer are laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Float32,
    Int16,
}

impl Encoding {
    pub fn bytes(self) -> usize {
        match self {
            Encoding::Float32 => 4,
            Encoding::Int16 => 2,
        }
    }
}

/// A source's PCM format, as its sample buffers describe it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    pub sample_rate: u32,
    pub channels: usize,
    pub encoding: Encoding,
    /// One plane per channel (ScreenCaptureKit) instead of one plane of interleaved samples.
    pub planar: bool,
}

/// Why a buffer could not be converted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConvertError {
    NoChannels,
    /// The planes do not match the format (a count or a length).
    Malformed,
}

/// Turns the planes of one buffer into interleaved stereo `f32`, at the source's own rate.
/// Mono is copied to both channels; more than two channels keep the first two.
pub fn to_stereo(format: &Format, planes: &[&[u8]]) -> Result<Vec<f32>, ConvertError> {
    if format.channels == 0 {
        return Err(ConvertError::NoChannels);
    }
    let width = format.encoding.bytes();
    let (plane_count, channels_per_plane) = if format.planar {
        (format.channels, 1)
    } else {
        (1, format.channels)
    };
    if planes.len() != plane_count {
        return Err(ConvertError::Malformed);
    }
    let frame_bytes = width * channels_per_plane;
    let frames = planes.first().map_or(0, |plane| plane.len() / frame_bytes);
    if planes
        .iter()
        .any(|plane| plane.len() < frames * frame_bytes)
    {
        return Err(ConvertError::Malformed);
    }
    let read = |plane: &[u8], frame: usize, channel: usize| -> f32 {
        let at = (frame * channels_per_plane + channel) * width;
        match format.encoding {
            Encoding::Float32 => {
                f32::from_le_bytes([plane[at], plane[at + 1], plane[at + 2], plane[at + 3]])
            }
            Encoding::Int16 => f32::from(i16::from_le_bytes([plane[at], plane[at + 1]])) / 32768.0,
        }
    };
    let mut out = Vec::with_capacity(frames * CHANNELS);
    for frame in 0..frames {
        let (left, right) = if format.planar {
            let left = read(planes[0], frame, 0);
            let right = if format.channels > 1 {
                read(planes[1], frame, 0)
            } else {
                left
            };
            (left, right)
        } else {
            let left = read(planes[0], frame, 0);
            let right = if format.channels > 1 {
                read(planes[0], frame, 1)
            } else {
                left
            };
            (left, right)
        };
        out.push(left);
        out.push(right);
    }
    Ok(out)
}

/// Converts stereo from `rate` to [`SAMPLE_RATE`] by linear interpolation, keeping its position
/// between buffers so the seams are inaudible. Both sources are asked for 48 kHz and normally
/// pass through unchanged; this covers an input device that cannot deliver it (a Bluetooth headset).
#[derive(Debug, Clone)]
pub struct Resampler {
    /// Input frames per output frame.
    step: f64,
    /// Position of the next output frame, in input frames relative to the start of the next buffer
    /// (negative: between the previous buffer's last frame and this one's first).
    position: f64,
    last: [f32; CHANNELS],
    identity: bool,
}

impl Resampler {
    pub fn new(rate: u32) -> Option<Self> {
        if rate == 0 {
            return None;
        }
        Some(Resampler {
            step: f64::from(rate) / f64::from(SAMPLE_RATE),
            position: 0.0,
            last: [0.0; CHANNELS],
            identity: rate == SAMPLE_RATE,
        })
    }

    /// `input` is interleaved stereo at the source rate; the result is at [`SAMPLE_RATE`].
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if self.identity {
            return input.to_vec();
        }
        let frames = (input.len() / CHANNELS) as f64;
        let mut out = Vec::with_capacity((input.len() as f64 / self.step) as usize + CHANNELS);
        // The sample at input position -1 is the previous buffer's last frame.
        while self.position < frames - 1.0 {
            let base = self.position.floor();
            let fraction = (self.position - base) as f32;
            for channel in 0..CHANNELS {
                let at = |index: i64| -> f32 {
                    if index < 0 {
                        self.last[channel]
                    } else {
                        input[index as usize * CHANNELS + channel]
                    }
                };
                let a = at(base as i64);
                let b = at(base as i64 + 1);
                out.push(a + (b - a) * fraction);
            }
            self.position += self.step;
        }
        if frames >= 1.0 {
            let end = input.len() - CHANNELS;
            self.last.copy_from_slice(&input[end..]);
        }
        self.position -= frames;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stereo frames whose two channels both hold `value`.
    fn tone(value: f32, frames: usize) -> Vec<f32> {
        vec![value; frames * CHANNELS]
    }

    fn rate() -> i64 {
        i64::from(SAMPLE_RATE)
    }

    #[test]
    fn time_to_frames_rounds_to_the_nearest_frame() {
        assert_eq!(frames_from_time(1, 1), Some(48_000));
        assert_eq!(frames_from_time(960, 48_000), Some(960));
        // 1/3 s at a timescale of 3: exactly 16 000 frames.
        assert_eq!(frames_from_time(1, 3), Some(16_000));
        // A host-clock value of ~700 000 s keeps its frame exactly, with a nanosecond timescale.
        assert_eq!(
            frames_from_time(706_287_411_596_125, 1_000_000_000),
            Some(33_901_795_757)
        );
        // Halves round away from zero.
        assert_eq!(frames_from_time(-1, 96_000), Some(-1));
        assert_eq!(frames_from_time(5, 0), None);
    }

    #[test]
    fn limit_is_identity_below_the_knee_and_stays_below_one() {
        for value in [0.0, 0.25, -0.5, 0.9, -0.9] {
            assert_eq!(limit(value), value);
        }
        let mut previous = limit(0.9);
        for step in 1..200 {
            let value = 0.9 + step as f32 * 0.05;
            let limited = limit(value);
            assert!(limited >= previous, "monotonic at {value}");
            assert!(limited <= 1.0);
            previous = limited;
        }
        assert!(limit(10.0) <= 1.0 && limit(-10.0) >= -1.0);
        assert_eq!(limit(-2.0), -limit(2.0));
        assert_eq!(limit(f32::NAN), 0.0);
        assert!(limit(f32::INFINITY) <= 1.0);
    }

    #[test]
    fn nothing_comes_out_before_the_start() {
        let mut mixer = Mixer::new();
        mixer.push(Source::System, 1000, &tone(0.5, 100));
        assert_eq!(mixer.drain_until(5000), None);
    }

    #[test]
    fn a_single_source_passes_through() {
        let mut mixer = Mixer::new();
        mixer.start(1000);
        let input: Vec<f32> = (0..200).map(|i| i as f32 / 400.0).collect();
        mixer.push(Source::Microphone, 1000, &input);
        let block = mixer.drain_until(1100).expect("a block");
        assert_eq!(block.start, 1000);
        assert_eq!(block.samples, input);
    }

    #[test]
    fn two_sources_are_summed_frame_by_frame() {
        let mut mixer = Mixer::new();
        mixer.start(0);
        mixer.push(Source::System, 0, &tone(0.25, 480));
        mixer.push(Source::Microphone, 0, &tone(0.125, 480));
        let block = mixer.drain_until(480).expect("a block");
        assert_eq!(block.frames(), 480);
        assert!(block.samples.iter().all(|&s| s == 0.375));
    }

    #[test]
    fn sources_are_aligned_by_timestamp() {
        let mut mixer = Mixer::new();
        mixer.start(0);
        // The microphone starts 100 frames later than the system audio.
        mixer.push(Source::System, 0, &tone(0.5, 300));
        mixer.push(Source::Microphone, 100, &tone(0.25, 200));
        let block = mixer.drain_until(300).expect("a block");
        let at = |frame: usize| block.samples[frame * CHANNELS];
        assert_eq!(at(0), 0.5);
        assert_eq!(at(99), 0.5);
        assert_eq!(at(100), 0.75);
        assert_eq!(at(299), 0.75);
    }

    #[test]
    fn audio_before_the_start_is_dropped_and_straddling_audio_is_cut() {
        let mut mixer = Mixer::new();
        mixer.push(Source::System, 0, &tone(0.5, 1000));
        mixer.start(400);
        let block = mixer.drain_until(1000).expect("a block");
        assert_eq!(block.start, 400);
        assert_eq!(block.frames(), 600);
        assert!(block.samples.iter().all(|&s| s == 0.5));
        // A buffer that straddles the start after it was set is cut the same way.
        let mut mixer = Mixer::new();
        mixer.start(400);
        mixer.push(Source::System, 200, &tone(0.5, 400));
        let block = mixer.drain_until(600).expect("a block");
        assert_eq!(block.start, 400);
        assert_eq!(block.frames(), 200);
        assert!(block.samples.iter().all(|&s| s == 0.5));
    }

    #[test]
    fn a_source_that_never_delivers_is_silence_and_holds_nothing_back() {
        let mut mixer = Mixer::new();
        mixer.start(0);
        let block = mixer.drain_until(4800).expect("a block");
        assert_eq!(block.frames(), 4800);
        assert!(block.samples.iter().all(|&s| s == 0.0));
        // The microphone is silent for a while, then speaks; the system audio never arrives.
        mixer.push(Source::Microphone, 9600, &tone(0.3, 480));
        let block = mixer.drain_until(10_080).expect("a block");
        assert_eq!(block.start, 4800);
        assert_eq!(block.samples[0], 0.0);
        assert_eq!(block.samples[(9600 - 4800) as usize * CHANNELS], 0.3);
    }

    #[test]
    fn a_gap_larger_than_the_tolerance_becomes_silence() {
        let mut mixer = Mixer::new();
        mixer.start(0);
        mixer.push(Source::System, 0, &tone(0.5, 1000));
        // The next buffer starts a full second after the first ended.
        let gap = 1000 + rate();
        mixer.push(Source::System, gap, &tone(0.5, 1000));
        let block = mixer.drain_until(gap + 1000).expect("a block");
        let at = |frame: i64| block.samples[frame as usize * CHANNELS];
        assert_eq!(at(999), 0.5);
        assert_eq!(at(1000), 0.0);
        assert_eq!(at(gap - 1), 0.0);
        assert_eq!(at(gap), 0.5);
    }

    #[test]
    fn timestamp_jitter_within_the_tolerance_stays_gapless() {
        let mut mixer = Mixer::new();
        mixer.start(0);
        // 20 ms buffers whose stamps wobble by up to ±5 ms, as real ones do.
        let jitter = [0_i64, 240, -240, 100, -100, 0];
        for (n, wobble) in jitter.iter().enumerate() {
            mixer.push(Source::Microphone, n as i64 * 960 + wobble, &tone(0.5, 960));
        }
        let block = mixer.drain_until(6 * 960).expect("a block");
        assert_eq!(block.frames(), 6 * 960);
        assert!(
            block.samples.iter().all(|&s| s == 0.5),
            "no gap, no overlap"
        );
    }

    #[test]
    fn a_source_clock_drift_inside_the_tolerance_is_followed_not_corrected() {
        // 40 ppm fast: after 600 s the source stamps run 24 ms ahead of the frames it delivered.
        let mut mixer = Mixer::new();
        mixer.start(0);
        let drift = 1152; // 24 ms in frames
        mixer.push(Source::Microphone, 0, &tone(0.5, 960));
        mixer.push(Source::Microphone, 960 + drift, &tone(0.5, 960));
        let block = mixer.drain_until(1920).expect("a block");
        assert!(block.samples.iter().all(|&s| s == 0.5));
    }

    #[test]
    fn an_overlap_larger_than_the_tolerance_is_dropped() {
        let mut mixer = Mixer::new();
        mixer.start(0);
        mixer.push(Source::System, 0, &tone(0.25, 10_000));
        // The source steps back by 6000 frames (more than 100 ms): the repeated part is dropped.
        mixer.push(Source::System, 4000, &tone(0.25, 8000));
        let block = mixer.drain_until(12_000).expect("a block");
        assert_eq!(block.frames(), 12_000);
        assert!(
            block.samples.iter().all(|&s| s == 0.25),
            "not doubled up anywhere"
        );
    }

    #[test]
    fn late_audio_is_dropped_without_corrupting_what_follows() {
        let mut mixer = Mixer::new();
        mixer.start(0);
        mixer.drain_until(1000);
        // Ends before what was handed out: dropped. Straddles it: cut.
        mixer.push(Source::System, 0, &tone(0.5, 800));
        mixer.push(Source::Microphone, 600, &tone(0.5, 800));
        let block = mixer.drain_until(2000).expect("a block");
        assert_eq!(block.start, 1000);
        let at = |frame: usize| block.samples[frame * CHANNELS];
        assert_eq!(at(0), 0.5);
        assert_eq!(at(399), 0.5);
        assert_eq!(at(400), 0.0);
    }

    #[test]
    fn the_sum_is_limited() {
        let mut mixer = Mixer::new();
        mixer.start(0);
        mixer.push(Source::System, 0, &tone(0.55, 100));
        mixer.push(Source::Microphone, 0, &tone(0.55, 100));
        let block = mixer.drain_until(100).expect("a block");
        // 1.1 would clip; the curve keeps it under 1 and above the knee.
        assert!(block.samples.iter().all(|&s| s > 0.9 && s < 1.0));
    }

    #[test]
    fn blocks_are_contiguous_and_cover_exactly_the_requested_span() {
        let mut mixer = Mixer::new();
        mixer.start(100);
        mixer.push(Source::System, 100, &tone(0.1, 5000));
        let a = mixer.drain_until(2100).expect("a block");
        assert_eq!(mixer.drain_until(2100), None);
        assert_eq!(mixer.drain_until(50), None);
        let b = mixer.drain_until(5100).expect("a block");
        assert_eq!(a.start, 100);
        assert_eq!(b.start, a.start + a.frames() as i64);
        assert_eq!(a.frames() + b.frames(), 5000);
        assert!(b.samples.iter().all(|&s| s == 0.1));
    }

    #[test]
    fn a_wrong_clock_is_corrected_by_a_constant_shift() {
        // Agreeing clocks (the buffer arrived 40 ms after it ended): no correction.
        assert_eq!(clock_correction(1_000_000, 1_000_000 + 1920), 0);
        assert_eq!(clock_correction(1_000_000, 1_000_000), 0);
        // A source stamped on another clock, 1 000 s behind: shift by that minus the assumed delay.
        let behind = 1000 * rate();
        assert_eq!(
            clock_correction(5_000_000, 5_000_000 + behind),
            behind - 2400
        );
        // And ahead.
        assert_eq!(
            clock_correction(5_000_000 + behind, 5_000_000),
            -behind - 2400
        );
    }

    fn bytes_f32(values: &[f32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    fn bytes_i16(values: &[i16]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn converts_planar_stereo_as_screencapturekit_delivers_it() {
        let format = Format {
            sample_rate: 48_000,
            channels: 2,
            encoding: Encoding::Float32,
            planar: true,
        };
        let left = bytes_f32(&[0.1, 0.2, 0.3]);
        let right = bytes_f32(&[-0.1, -0.2, -0.3]);
        let out = to_stereo(&format, &[&left, &right]).expect("converts");
        assert_eq!(out, [0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
    }

    #[test]
    fn converts_interleaved_mono_as_the_microphone_delivers_it() {
        let format = Format {
            sample_rate: 48_000,
            channels: 1,
            encoding: Encoding::Float32,
            planar: false,
        };
        let mono = bytes_f32(&[0.5, -0.25]);
        let out = to_stereo(&format, &[&mono]).expect("converts");
        assert_eq!(out, [0.5, 0.5, -0.25, -0.25]);
    }

    #[test]
    fn converts_sixteen_bit_and_drops_extra_channels() {
        let format = Format {
            sample_rate: 44_100,
            channels: 3,
            encoding: Encoding::Int16,
            planar: false,
        };
        let data = bytes_i16(&[16384, -16384, 32767, 0, 0, 0]);
        let out = to_stereo(&format, &[&data]).expect("converts");
        assert_eq!(out.len(), 4);
        assert_eq!(out[0], 0.5);
        assert_eq!(out[1], -0.5);
        assert!(out[2] == 0.0 && out[3] == 0.0);
    }

    #[test]
    fn refuses_buffers_that_do_not_match_their_format() {
        let planar = Format {
            sample_rate: 48_000,
            channels: 2,
            encoding: Encoding::Float32,
            planar: true,
        };
        let one = bytes_f32(&[0.0; 4]);
        assert_eq!(
            to_stereo(&planar, &[&one]),
            Err(ConvertError::Malformed),
            "a plane is missing"
        );
        let short = bytes_f32(&[0.0; 2]);
        assert_eq!(
            to_stereo(&planar, &[&one, &short]),
            Err(ConvertError::Malformed),
            "planes of different lengths"
        );
        let none = Format {
            channels: 0,
            ..planar
        };
        assert_eq!(to_stereo(&none, &[]), Err(ConvertError::NoChannels));
        // A trailing partial frame is ignored, not an error.
        let interleaved = Format {
            planar: false,
            channels: 2,
            ..planar
        };
        let ragged = [bytes_f32(&[0.1, 0.2, 0.3]), vec![0, 0]].concat();
        assert_eq!(to_stereo(&interleaved, &[&ragged]).expect("ok").len(), 2);
    }

    #[test]
    fn resampling_at_the_output_rate_is_the_identity() {
        let mut resampler = Resampler::new(SAMPLE_RATE).expect("a rate");
        let input: Vec<f32> = (0..20).map(|i| i as f32).collect();
        assert_eq!(resampler.process(&input), input);
        assert!(Resampler::new(0).is_none());
    }

    #[test]
    fn resampling_keeps_the_duration_across_buffers() {
        // 24 kHz to 48 kHz: twice the frames, in total, however the input is cut into buffers.
        let mut whole = Resampler::new(24_000).expect("a rate");
        let signal: Vec<f32> = (0..2400)
            .flat_map(|i| [(i as f32 / 100.0).sin(); 2])
            .collect();
        let reference = whole.process(&signal);
        let mut cut = Resampler::new(24_000).expect("a rate");
        let mut pieces = Vec::new();
        for part in signal.chunks(7 * CHANNELS) {
            pieces.extend(cut.process(part));
        }
        let expected = 4800;
        assert!(
            reference.len() / CHANNELS >= expected - 2 && reference.len() / CHANNELS <= expected,
            "{}",
            reference.len() / CHANNELS
        );
        assert_eq!(pieces.len(), reference.len());
        for (a, b) in pieces.iter().zip(&reference) {
            assert!((a - b).abs() < 1e-5, "cutting the input changed the output");
        }
    }

    #[test]
    fn resampling_interpolates_and_keeps_a_constant_signal_constant() {
        let mut up = Resampler::new(24_000).expect("a rate");
        let out = up.process(&[0.0, 0.0, 1.0, 1.0, 2.0, 2.0]);
        // Output frames at input positions 0, 0.5, 1, 1.5: 0, 0.5, 1, 1.5.
        assert_eq!(&out[..8], [0.0, 0.0, 0.5, 0.5, 1.0, 1.0, 1.5, 1.5]);
        let mut down = Resampler::new(96_000).expect("a rate");
        let flat = down.process(&tone(0.4, 400));
        assert_eq!(flat.len(), 200 * CHANNELS);
        assert!(flat.iter().all(|&s| (s - 0.4).abs() < 1e-6));
    }
}
