//! GIF export of a finished recording (ADR-037, task 4): the pure part.
//!
//! The MP4 is decoded by the platform backend (`AVAssetReader` on macOS), which hands each picture,
//! with its presentation time, to a [`GifWriter`]. Everything else is here and free of platform
//! calls so it is tested alone: the limits, the output size, the size estimate, resampling the
//! video's timeline to the GIF's frame rate, the box downscale, the delays in centiseconds and the
//! `gif` encoder.
//!
//! **Timing comes from timestamps, never from frame counts.** A still screen yields few video
//! frames (ScreenCaptureKit only sends changes), so the output is sampled on a fixed clock of
//! `fps` ticks over the recording's length: each tick shows the newest picture at or before it, and
//! consecutive ticks that show the same picture become one GIF frame with a longer delay. A
//! recording of a static screen is therefore one frame with a long delay, not a one-frame GIF that
//! flashes by.
//!
//! **Memory.** Pictures are scaled the moment they arrive and the source picture is released by the
//! caller; the writer holds at most three scaled pictures (the one waiting for its duration, the one
//! waiting to be merged or written, and the one being built), never the recording.

use std::fmt;
use std::io::Write;
use std::time::Duration;

use gif::{DisposalMethod, Encoder, Frame, Repeat};
use serde::{Deserialize, Serialize};

/// Highest frame rate offered, and the default (ADR-037).
pub const MAX_FPS: u32 = 15;
pub const DEFAULT_FPS: u32 = 10;
/// Widest GIF, in pixels.
pub const MAX_WIDTH: u32 = 800;
/// Narrowest GIF; the recording itself is never smaller than 16 px.
pub const MIN_WIDTH: u32 = 16;
/// The longest source a GIF is made from. A longer recording would need a trim, which this version
/// does not have, so it is refused with a message that says so.
pub const MAX_SOURCE: Duration = Duration::from_secs(60);
/// NeuQuant sampling speed (1 = best, 30 = fastest) for pictures with more than 256 colours;
/// pictures with at most 256 get their exact palette whatever this is. 10 is the crate's own
/// "good compromise".
const QUANTIZER_SPEED: i32 = 10;
/// Typical output of a busy screen, in bytes per pixel per output tick, for the size estimate. It is
/// an upper-ish figure: pictures that repeat cost nothing and flat UI compresses far better. Measured
/// in ADR-037.
const ESTIMATE_BYTES_PER_PIXEL: f64 = 0.14;

/// One decoded picture of the recording, as a backend's frame source hands it over. The pixels are
/// only valid during the call that receives it.
pub struct Picture<'a> {
    /// Presentation time in seconds on the video's own clock.
    pub time: f64,
    pub size: (u32, u32),
    /// Bytes from one row to the next; may exceed `size.0 * 4`.
    pub stride: usize,
    pub bgra: &'a [u8],
}

/// Why a backend's frame source stopped before the end of the video.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    Cancelled,
    Failed(String),
}

/// What the user chose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GifOptions {
    pub fps: u32,
    /// Output width in pixels; the height follows the recording's aspect ratio.
    pub width: u32,
}

/// What an export with the chosen options will produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GifPlan {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Ticks of the output clock over the whole recording: the most pictures the GIF can have.
    pub ticks: u64,
    /// A rough size, for the dialog before saving.
    pub estimated_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GifError {
    TooLong(Duration),
    BadFps(u32),
    BadWidth {
        width: u32,
        max: u32,
    },
    /// The decoder delivered a picture of another size than the recording's.
    FrameSize {
        expected: (u32, u32),
        got: (u32, u32),
    },
    /// The decoder delivered less data than the picture's size needs.
    ShortFrame,
    NoFrames,
    Encoding(String),
}

impl fmt::Display for GifError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GifError::TooLong(length) => write!(
                f,
                "This recording is {} long. A GIF can be made from at most {} seconds of video; \
                 save it as an MP4 instead.",
                super::clock(*length),
                MAX_SOURCE.as_secs()
            ),
            GifError::BadFps(fps) => {
                write!(
                    f,
                    "The frame rate must be between 1 and {MAX_FPS} (got {fps})."
                )
            }
            GifError::BadWidth { width, max } => write!(
                f,
                "The width must be between {MIN_WIDTH} and {max} pixels (got {width})."
            ),
            GifError::FrameSize { expected, got } => write!(
                f,
                "The video changed size from {}×{} to {}×{}.",
                expected.0, expected.1, got.0, got.1
            ),
            GifError::ShortFrame => f.write_str("A picture of the video was incomplete."),
            GifError::NoFrames => f.write_str("The recording has no picture to make a GIF from."),
            GifError::Encoding(reason) => write!(f, "The GIF could not be written: {reason}"),
        }
    }
}

impl From<gif::EncodingError> for GifError {
    fn from(error: gif::EncodingError) -> Self {
        GifError::Encoding(error.to_string())
    }
}

/// The widest GIF of a recording `pixel_width` pixels wide.
pub fn max_width(pixel_width: u32) -> u32 {
    pixel_width.min(MAX_WIDTH)
}

/// The default width: the region's width in display points (1×, so a Retina recording is not
/// doubled), never wider than the video or `MAX_WIDTH`.
pub fn default_width(points_width: u32, pixel_width: u32) -> u32 {
    let max = max_width(pixel_width);
    points_width.clamp(MIN_WIDTH.min(max), max.max(1))
}

/// Number of output ticks for a recording of `duration` at `fps`: at least one.
fn total_ticks(duration: Duration, fps: u32) -> u64 {
    ((duration.as_secs_f64() * f64::from(fps)).round() as u64).max(1)
}

/// Checks the limits and works out the output. `source` is the video's size in pixels.
pub fn plan(
    source: (u32, u32),
    duration: Duration,
    options: GifOptions,
) -> Result<GifPlan, GifError> {
    if duration > MAX_SOURCE {
        return Err(GifError::TooLong(duration));
    }
    if options.fps == 0 || options.fps > MAX_FPS {
        return Err(GifError::BadFps(options.fps));
    }
    let max = max_width(source.0);
    if source.0 == 0 || source.1 == 0 || options.width < MIN_WIDTH.min(max) || options.width > max {
        return Err(GifError::BadWidth {
            width: options.width,
            max,
        });
    }
    let width = options.width;
    let height = ((u64::from(source.1) * u64::from(width) + u64::from(source.0) / 2)
        / u64::from(source.0))
    .max(1) as u32;
    let ticks = total_ticks(duration, options.fps);
    let pixels = f64::from(width) * f64::from(height);
    Ok(GifPlan {
        width,
        height,
        fps: options.fps,
        ticks,
        estimated_bytes: (pixels * ticks as f64 * ESTIMATE_BYTES_PER_PIXEL) as u64,
    })
}

/// The GIF's clock: which output ticks one source picture covers.
#[derive(Debug, Clone)]
struct Resampler {
    fps: f64,
    total: u64,
    /// The first tick that no picture has claimed yet.
    cursor: u64,
}

impl Resampler {
    fn new(fps: u32, total: u64) -> Self {
        Resampler {
            fps: f64::from(fps),
            total,
            cursor: 0,
        }
    }

    /// The number of ticks the picture before `next` covers: those from the first unclaimed one up
    /// to (not including) the tick at which `next` shows. `None` is the end of the recording.
    /// Zero means the picture was replaced before any tick looked at it: it is dropped.
    fn span(&mut self, next: Option<f64>) -> u64 {
        let end = match next {
            // A tick shows `next` once its time reaches `next`'s: ticks strictly before it still
            // show the older picture. The epsilon keeps 0.3 s × 10 fps from becoming 3.0000000000000004.
            Some(time) => ((time * self.fps - 1e-6).ceil().max(0.0) as u64).min(self.total),
            None => self.total,
        };
        let ticks = end.saturating_sub(self.cursor);
        self.cursor = self.cursor.max(end);
        ticks
    }

    /// How far through the recording the claimed ticks are, 0..=1.
    fn fraction(&self) -> f64 {
        (self.cursor as f64 / self.total as f64).clamp(0.0, 1.0)
    }
}

/// The GIF delay, in hundredths of a second, of `ticks` ticks that start at tick `start`. Rounding
/// the cumulative time rather than each delay keeps the GIF's length equal to the recording's:
/// 15 fps is 6.67 cs per tick, and rounding every frame would make a minute 4 s too long.
fn delay_cs(fps: u32, start: u64, ticks: u64) -> u16 {
    let at = |tick: u64| (tick * 100 + u64::from(fps) / 2) / u64::from(fps);
    // At most 60 s = 6000 cs, far inside a GIF delay's 16 bits; saturate rather than wrap.
    u16::try_from(at(start + ticks) - at(start)).unwrap_or(u16::MAX)
}

/// Box-filter downscale of a BGRA picture (rows `stride` bytes apart, maybe padded) to
/// `dst_width × dst_height` straight RGBA with full alpha, written to `out`. Every output pixel is
/// the mean of the source pixels it covers, so thin lines and text stay readable where
/// nearest-neighbour would drop them.
pub fn scale_bgra_to_rgba(
    src: &[u8],
    src_size: (u32, u32),
    stride: usize,
    dst_size: (u32, u32),
    out: &mut Vec<u8>,
) -> Result<(), GifError> {
    let (sw, sh) = (src_size.0 as usize, src_size.1 as usize);
    let (dw, dh) = (dst_size.0 as usize, dst_size.1 as usize);
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 || stride < sw * 4 {
        return Err(GifError::ShortFrame);
    }
    if src.len() < stride * (sh - 1) + sw * 4 {
        return Err(GifError::ShortFrame);
    }
    // The source columns and rows of each output column and row; never empty, so upscaling
    // (not offered) would still work.
    let spans = |source: usize, target: usize| -> Vec<(usize, usize)> {
        (0..target)
            .map(|i| {
                let first = i * source / target;
                let last = ((i + 1) * source / target).max(first + 1).min(source);
                (first, last)
            })
            .collect()
    };
    let columns = spans(sw, dw);
    let rows = spans(sh, dh);
    out.clear();
    out.reserve(dw * dh * 4);
    for &(y0, y1) in &rows {
        for &(x0, x1) in &columns {
            let (mut b, mut g, mut r) = (0u32, 0u32, 0u32);
            for y in y0..y1 {
                let row = &src[y * stride + x0 * 4..y * stride + x1 * 4];
                for px in row.as_chunks::<4>().0 {
                    b += u32::from(px[0]);
                    g += u32::from(px[1]);
                    r += u32::from(px[2]);
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as u32;
            let mean = |sum: u32| ((sum + count / 2) / count) as u8;
            out.extend_from_slice(&[mean(r), mean(g), mean(b), 255]);
        }
    }
    Ok(())
}

/// A scaled picture that has been given its ticks and waits to be merged with identical successors.
struct Pending {
    rgba: Vec<u8>,
    start: u64,
    ticks: u64,
}

/// Turns the decoded pictures of a recording into a GIF, one picture at a time.
///
/// Call [`push`](GifWriter::push) for every picture in presentation order, then
/// [`finish`](GifWriter::finish).
pub struct GifWriter<W: Write> {
    encoder: Encoder<W>,
    plan: GifPlan,
    source: (u32, u32),
    resampler: Resampler,
    /// Presentation time of the first picture; the recording starts there.
    origin: Option<f64>,
    last_time: f64,
    /// The newest picture, scaled, whose duration is not known until the next one arrives.
    held: Option<Vec<u8>>,
    pending: Option<Pending>,
    /// First tick after everything handed to `pending`.
    cursor: u64,
    frames: u32,
}

impl<W: Write> GifWriter<W> {
    /// `source` is the video's size in pixels and `plan` comes from [`plan`] for that size.
    pub fn new(writer: W, source: (u32, u32), plan: GifPlan) -> Result<Self, GifError> {
        // `plan` limits both sides to 800, so they fit the GIF's 16 bits.
        let (width, height) = (plan.width as u16, plan.height as u16);
        let mut encoder = Encoder::new(writer, width, height, &[])?;
        encoder.set_repeat(Repeat::Infinite)?;
        Ok(GifWriter {
            encoder,
            plan,
            source,
            resampler: Resampler::new(plan.fps, plan.ticks),
            origin: None,
            last_time: 0.0,
            held: None,
            pending: None,
            cursor: 0,
            frames: 0,
        })
    }

    /// How far the export is, 0..=1, by the recording's own clock.
    pub fn fraction(&self) -> f64 {
        self.resampler.fraction()
    }

    /// Takes the picture shown from `time` (seconds on the video's clock). `bgra` is the picture's
    /// pixels, rows `stride` bytes apart; it is only read during the call.
    pub fn push(
        &mut self,
        time: f64,
        bgra: &[u8],
        stride: usize,
        size: (u32, u32),
    ) -> Result<(), GifError> {
        if size != self.source {
            return Err(GifError::FrameSize {
                expected: self.source,
                got: size,
            });
        }
        let origin = *self.origin.get_or_insert(time);
        // The decoder delivers in presentation order; a stamp that goes backwards is clamped so the
        // clock never does.
        let time = (time - origin).max(self.last_time);
        self.last_time = time;
        // The previous picture lasts until this one.
        if let Some(held) = self.held.take() {
            let ticks = self.resampler.span(Some(time));
            if ticks > 0 {
                self.add(held, ticks)?;
            }
        }
        let mut scaled = Vec::new();
        scale_bgra_to_rgba(
            bgra,
            size,
            stride,
            (self.plan.width, self.plan.height),
            &mut scaled,
        )?;
        self.held = Some(scaled);
        Ok(())
    }

    /// Gives `rgba` its `ticks` ticks, merging it into the pending frame when it is identical.
    fn add(&mut self, rgba: Vec<u8>, ticks: u64) -> Result<(), GifError> {
        if let Some(pending) = &mut self.pending
            && pending.rgba == rgba
        {
            pending.ticks += ticks;
        } else {
            self.flush()?;
            self.pending = Some(Pending {
                rgba,
                start: self.cursor,
                ticks,
            });
        }
        self.cursor += ticks;
        Ok(())
    }

    fn flush(&mut self) -> Result<(), GifError> {
        let Some(mut pending) = self.pending.take() else {
            return Ok(());
        };
        let mut frame = Frame::from_rgba_speed(
            self.plan.width as u16,
            self.plan.height as u16,
            &mut pending.rgba,
            QUANTIZER_SPEED,
        );
        frame.delay = delay_cs(self.plan.fps, pending.start, pending.ticks);
        frame.dispose = DisposalMethod::Keep;
        self.encoder.write_frame(&frame)?;
        self.frames += 1;
        Ok(())
    }

    /// Writes the last picture for the rest of the recording and the trailer; returns the writer.
    #[cfg(test)]
    pub fn finish(self) -> Result<W, GifError> {
        self.finish_counted().map(|(writer, _)| writer)
    }

    /// `finish`, and the number of GIF frames written.
    pub fn finish_counted(mut self) -> Result<(W, u32), GifError> {
        if let Some(held) = self.held.take() {
            let ticks = self.resampler.span(None);
            if ticks > 0 {
                self.add(held, ticks)?;
            }
        }
        self.flush()?;
        if self.frames == 0 {
            return Err(GifError::NoFrames);
        }
        let frames = self.frames;
        Ok((self.encoder.into_inner()?, frames))
    }
}

/// Why an export ended without a GIF.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportFailure {
    Cancelled,
    Failed(String),
}

/// Runs a whole export: `read` is the backend's frame source, which calls the function it is given
/// for each picture and stops at the first error; `progress` hears how far the recording is (0..=1)
/// after every picture. Returns the writer the GIF went to and the number of GIF frames.
pub fn export<W: Write>(
    writer: W,
    source: (u32, u32),
    plan: GifPlan,
    read: impl FnOnce(&mut dyn FnMut(Picture<'_>) -> Result<(), String>) -> Result<(), ReadError>,
    mut progress: impl FnMut(f64),
) -> Result<(W, u32), ExportFailure> {
    let failed = |error: GifError| ExportFailure::Failed(error.to_string());
    let mut gif = GifWriter::new(writer, source, plan).map_err(failed)?;
    read(&mut |picture| {
        gif.push(picture.time, picture.bgra, picture.stride, picture.size)
            .map_err(|error| error.to_string())?;
        progress(gif.fraction());
        Ok(())
    })
    .map_err(|error| match error {
        ReadError::Cancelled => ExportFailure::Cancelled,
        ReadError::Failed(reason) => ExportFailure::Failed(reason),
    })?;
    gif.finish_counted().map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The limits' worst case: 60 s of 1080p at 15 fps into 800 px, pictures changing all the time.
    /// Prints the time and the size, and checks nothing but that it finishes; run with
    /// `/usr/bin/time -l cargo test --release -- --ignored --nocapture worst_case` and read the
    /// test binary's peak memory from a direct run of it. Measured numbers are in ADR-037.
    #[test]
    #[ignore = "a measurement, not a check"]
    fn worst_case_export_time_and_size() {
        struct Count(u64);
        impl Write for Count {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0 += buf.len() as u64;
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (w, h) = (1920u32, 1080u32);
        let p = plan((w, h), secs(60), options(15, 800)).unwrap();
        let started = std::time::Instant::now();
        let mut picture = vec![0u8; (w * h * 4) as usize];
        let (count, frames) = export(
            Count(0),
            (w, h),
            p,
            |next| {
                for n in 0..900u32 {
                    // A gradient with a bar and some text-like stripes that move every picture.
                    for y in 0..h {
                        for x in 0..w {
                            let i = ((y * w + x) * 4) as usize;
                            let bar = (x + n * 7) % 400 < 40 && y > 200 && y < 600;
                            let stripe = y % 24 < 2 && (x / 8 + n) % 5 != 0;
                            let v = if bar || stripe { 20 } else { 200 };
                            picture[i..i + 4].copy_from_slice(&[
                                v,
                                (x / 8) as u8,
                                (y / 5) as u8,
                                255,
                            ]);
                        }
                    }
                    next(Picture {
                        time: f64::from(n) / 15.0,
                        size: (w, h),
                        stride: (w * 4) as usize,
                        bgra: &picture,
                    })
                    .map_err(ReadError::Failed)?;
                }
                Ok(())
            },
            |_| {},
        )
        .unwrap();
        println!(
            "{frames} frames, {} bytes, {:?}, plan estimate {}",
            count.0,
            started.elapsed(),
            p.estimated_bytes
        );
    }

    #[test]
    fn a_whole_export_streams_pictures_and_reports_progress() {
        let p = plan((8, 8), secs(2), options(10, 8)).unwrap();
        let mut seen = Vec::new();
        let (bytes, count) = export(
            Vec::new(),
            (8, 8),
            p,
            |next| {
                for (time, color) in [(3.0, [0, 0, 255]), (3.5, [0, 255, 0]), (4.0, [255, 0, 0])] {
                    next(Picture {
                        time,
                        size: (8, 8),
                        stride: 32,
                        bgra: &solid(8, 8, color),
                    })
                    .map_err(ReadError::Failed)?;
                }
                Ok(())
            },
            |fraction| seen.push(fraction),
        )
        .unwrap();
        let (_, frames) = decode(&bytes);
        assert_eq!(
            frames.iter().map(|f| u32::from(f.0)).sum::<u32>(),
            200,
            "as long as the recording"
        );
        assert_eq!(frames.len(), 3);
        assert_eq!(count, 3);
        assert_eq!(seen.len(), 3);
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "{seen:?}");
        assert!(seen.iter().all(|f| (0.0..=1.0).contains(f)));
    }

    #[test]
    fn a_cancelled_or_failed_read_ends_the_export() {
        let p = plan((8, 8), secs(2), options(10, 8)).unwrap();
        let cancelled = export(Vec::new(), (8, 8), p, |_| Err(ReadError::Cancelled), |_| {});
        assert_eq!(cancelled.unwrap_err(), ExportFailure::Cancelled);
        let failed = export(
            Vec::new(),
            (8, 8),
            p,
            |_| Err(ReadError::Failed("broken".into())),
            |_| {},
        );
        assert_eq!(failed.unwrap_err(), ExportFailure::Failed("broken".into()));
        // A picture of the wrong size stops the reader through the callback's error.
        let wrong = export(
            Vec::new(),
            (8, 8),
            p,
            |next| {
                next(Picture {
                    time: 0.0,
                    size: (4, 4),
                    stride: 16,
                    bgra: &solid(4, 4, [0, 0, 0]),
                })
                .map_err(ReadError::Failed)
            },
            |_| {},
        );
        assert!(
            matches!(wrong.unwrap_err(), ExportFailure::Failed(m) if m.contains("changed size"))
        );
        // A video without a single picture is an error, not an empty file.
        let empty = export(Vec::new(), (8, 8), p, |_| Ok(()), |_| {});
        assert!(matches!(empty.unwrap_err(), ExportFailure::Failed(_)));
    }

    fn options(fps: u32, width: u32) -> GifOptions {
        GifOptions { fps, width }
    }

    fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    #[test]
    fn the_limits_are_enforced_with_clear_messages() {
        let source = (1920, 1080);
        assert!(plan(source, secs(60), options(15, 800)).is_ok());
        let long = plan(source, Duration::from_millis(60_001), options(10, 800)).unwrap_err();
        assert!(matches!(long, GifError::TooLong(_)));
        let message = long.to_string();
        assert!(
            message.contains("1:00") && message.contains("60 seconds"),
            "{message}"
        );
        assert_eq!(
            plan(source, secs(5), options(16, 800)),
            Err(GifError::BadFps(16))
        );
        assert_eq!(
            plan(source, secs(5), options(0, 800)),
            Err(GifError::BadFps(0))
        );
        assert_eq!(
            plan(source, secs(5), options(10, 801)),
            Err(GifError::BadWidth {
                width: 801,
                max: 800
            })
        );
        assert!(plan(source, secs(5), options(10, 15)).is_err());
        // Never wider than the video itself: no upscaling.
        assert_eq!(
            plan((320, 240), secs(5), options(10, 321)),
            Err(GifError::BadWidth {
                width: 321,
                max: 320
            })
        );
        assert!(plan((320, 240), secs(5), options(10, 320)).is_ok());
    }

    #[test]
    fn the_output_size_keeps_the_aspect_ratio() {
        let p = plan((1920, 1080), secs(10), options(10, 800)).unwrap();
        assert_eq!((p.width, p.height), (800, 450));
        let p = plan((1001, 333), secs(10), options(10, 500)).unwrap();
        assert_eq!((p.width, p.height), (500, 166));
        // A very wide strip never rounds to a zero height.
        let p = plan((8000, 16), secs(1), options(5, 800)).unwrap();
        assert_eq!((p.width, p.height), (800, 2));
        let p = plan((8000, 16), secs(1), options(5, 100)).unwrap();
        assert_eq!(p.height, 1);
    }

    #[test]
    fn the_default_width_is_one_x_and_capped() {
        // A Retina region of 600 points is 1200 px: the GIF defaults to 600.
        assert_eq!(default_width(600, 1200), 600);
        assert_eq!(default_width(1440, 2880), 800);
        assert_eq!(default_width(300, 300), 300);
        // A 1× display: points and pixels agree.
        assert_eq!(default_width(2000, 2000), 800);
        assert_eq!(max_width(320), 320);
        assert_eq!(max_width(4000), 800);
        // Always acceptable to `plan`.
        for (points, pixels) in [(16, 32), (500, 500), (3000, 6000)] {
            let width = default_width(points, pixels);
            assert!(plan((pixels, 100), secs(1), options(10, width)).is_ok());
        }
    }

    #[test]
    fn the_estimate_grows_with_size_length_and_rate() {
        let base = plan((1920, 1080), secs(10), options(10, 400)).unwrap();
        let wider = plan((1920, 1080), secs(10), options(10, 800)).unwrap();
        let longer = plan((1920, 1080), secs(20), options(10, 400)).unwrap();
        let faster = plan((1920, 1080), secs(10), options(15, 400)).unwrap();
        assert!(base.estimated_bytes > 0);
        assert!(wider.estimated_bytes > base.estimated_bytes);
        assert!(longer.estimated_bytes > base.estimated_bytes);
        assert!(faster.estimated_bytes > base.estimated_bytes);
        assert_eq!(base.ticks, 100);
        assert_eq!(faster.ticks, 150);
        // A zero-length recording still has one picture.
        assert_eq!(
            plan((100, 100), Duration::ZERO, options(10, 100))
                .unwrap()
                .ticks,
            1
        );
    }

    #[test]
    fn one_picture_covers_the_whole_recording() {
        // A still screen: one video frame, five seconds.
        let mut clock = Resampler::new(10, total_ticks(secs(5), 10));
        assert_eq!(clock.span(None), 50);
        assert_eq!(clock.fraction(), 1.0);
    }

    #[test]
    fn pictures_cover_the_ticks_between_their_stamps() {
        let mut clock = Resampler::new(10, 50);
        // The picture shown from 0 s until the next one at 0.3 s covers ticks 0, 1 and 2 (0.0, 0.1,
        // 0.2 s); the tick at 0.3 s already shows the next picture.
        assert_eq!(clock.span(Some(0.3)), 3);
        // Float noise on a tick boundary does not shift the picture by one.
        assert_eq!(clock.span(Some(0.1 + 0.2 + 0.4)), 4);
        assert_eq!(clock.span(Some(0.75)), 1);
        assert_eq!(clock.span(None), 50 - 8);
    }

    #[test]
    fn a_picture_replaced_before_a_tick_is_dropped() {
        let mut clock = Resampler::new(10, 50);
        assert_eq!(clock.span(Some(0.03)), 1); // covers tick 0 only
        assert_eq!(clock.span(Some(0.05)), 0); // between two ticks: nobody looks at it
        assert_eq!(clock.span(Some(0.04)), 0); // out of order: nothing is given back
        assert_eq!(clock.span(Some(0.2)), 1);
        // Pictures past the end add nothing.
        assert_eq!(clock.span(Some(99.0)), 48);
        assert_eq!(clock.span(None), 0);
    }

    #[test]
    fn delays_add_up_to_the_recording_length() {
        // 15 fps is 6.67 cs per tick: every delay is 6 or 7, and a minute is exactly 6000 cs.
        let mut total = 0u32;
        for start in 0..900 {
            let d = delay_cs(15, start, 1);
            assert!((6..=7).contains(&d), "{d}");
            total += u32::from(d);
        }
        assert_eq!(total, 6000);
        // Merged ticks round once, not per tick.
        assert_eq!(delay_cs(15, 0, 900), 6000);
        assert_eq!(delay_cs(10, 3, 5), 50);
        assert_eq!(delay_cs(1, 0, 1), 100);
        assert_eq!(delay_cs(7, 0, 7), 100);
        // Never below what browsers still honour (they treat 0 and 1 cs as 10 cs).
        assert!((0..15).all(|s| delay_cs(15, s, 1) >= 6));
    }

    #[test]
    fn the_box_filter_averages_what_it_covers() {
        // 4×2 BGRA: left half black, right half white; to 2×1 → black, white.
        let mut src = Vec::new();
        for _ in 0..2 {
            for x in 0..4 {
                let v = if x < 2 { 0 } else { 255 };
                src.extend_from_slice(&[v, v, v, 255]);
            }
        }
        let mut out = Vec::new();
        scale_bgra_to_rgba(&src, (4, 2), 16, (2, 1), &mut out).unwrap();
        assert_eq!(out, [0, 0, 0, 255, 255, 255, 255, 255]);
        // One output pixel over a black and white pair is grey.
        scale_bgra_to_rgba(&src, (4, 2), 16, (1, 1), &mut out).unwrap();
        assert_eq!(out[..3], [128, 128, 128]);
        assert_eq!(out[3], 255);
    }

    #[test]
    fn channels_are_swapped_and_alpha_forced() {
        // BGRA (blue, green, red, alpha 0) becomes RGBA with alpha 255.
        let src = [10u8, 20, 30, 0];
        let mut out = Vec::new();
        scale_bgra_to_rgba(&src, (1, 1), 4, (1, 1), &mut out).unwrap();
        assert_eq!(out, [30, 20, 10, 255]);
    }

    #[test]
    fn row_padding_is_skipped() {
        // 2×2 pixels in rows of 12 bytes (4 bytes of padding of 0xEE that must not be read).
        let mut src = Vec::new();
        for _ in 0..2 {
            src.extend_from_slice(&[1, 2, 3, 255, 1, 2, 3, 255]);
            src.extend_from_slice(&[0xEE; 4]);
        }
        let mut out = Vec::new();
        scale_bgra_to_rgba(&src, (2, 2), 12, (2, 2), &mut out).unwrap();
        assert_eq!(out, [3, 2, 1, 255].repeat(4));
        // The last row needs no padding at all.
        scale_bgra_to_rgba(&src[..20], (2, 2), 12, (1, 1), &mut out).unwrap();
        assert!(scale_bgra_to_rgba(&src[..19], (2, 2), 12, (1, 1), &mut out).is_err());
    }

    #[test]
    fn bad_inputs_are_errors_not_panics() {
        let mut out = Vec::new();
        assert!(scale_bgra_to_rgba(&[], (0, 0), 0, (1, 1), &mut out).is_err());
        assert!(scale_bgra_to_rgba(&[0; 16], (2, 2), 4, (1, 1), &mut out).is_err());
        assert!(scale_bgra_to_rgba(&[0; 8], (2, 2), 8, (1, 1), &mut out).is_err());
    }

    /// A solid BGRA picture.
    fn solid(width: u32, height: u32, bgr: [u8; 3]) -> Vec<u8> {
        [bgr[0], bgr[1], bgr[2], 255].repeat((width * height) as usize)
    }

    type Decoded<'a> = (gif::Decoder<std::io::Cursor<&'a [u8]>>, Vec<(u16, [u8; 3])>);

    fn decode(bytes: &[u8]) -> Decoded<'_> {
        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::RGBA);
        let mut decoder = options.read_info(std::io::Cursor::new(bytes)).unwrap();
        let mut frames = Vec::new();
        while let Some(frame) = decoder.read_next_frame().unwrap() {
            let pixel = [frame.buffer[0], frame.buffer[1], frame.buffer[2]];
            frames.push((frame.delay, pixel));
        }
        (decoder, frames)
    }

    fn writer(source: (u32, u32), duration: Duration, fps: u32) -> GifWriter<Vec<u8>> {
        let p = plan(source, duration, options(fps, source.0)).unwrap();
        GifWriter::new(Vec::new(), source, p).unwrap()
    }

    #[test]
    fn a_still_screen_is_one_frame_with_the_whole_delay() {
        let mut w = writer((8, 8), secs(5), 10);
        w.push(100.0, &solid(8, 8, [0, 0, 255]), 32, (8, 8))
            .unwrap();
        assert_eq!(w.fraction(), 0.0);
        let bytes = w.finish().unwrap();
        let (decoder, frames) = decode(&bytes);
        assert_eq!(frames, [(500, [255, 0, 0])]);
        assert_eq!((decoder.width(), decoder.height()), (8, 8));
        assert_eq!(&bytes[..6], b"GIF89a");
        assert_eq!(*bytes.last().unwrap(), 0x3B);
        // It loops: the NETSCAPE extension is there.
        assert!(bytes.windows(11).any(|w| w == b"NETSCAPE2.0"));
    }

    #[test]
    fn timing_follows_the_stamps_not_the_frame_count() {
        // Red 0–1 s, green 1–1.5 s, blue to the end (3 s); only three source frames.
        let mut w = writer((8, 8), secs(3), 10);
        w.push(7.0, &solid(8, 8, [0, 0, 255]), 32, (8, 8)).unwrap();
        w.push(8.0, &solid(8, 8, [0, 255, 0]), 32, (8, 8)).unwrap();
        w.push(8.5, &solid(8, 8, [255, 0, 0]), 32, (8, 8)).unwrap();
        let (_, frames) = decode(&w.finish().unwrap());
        assert_eq!(
            frames,
            [(100, [255, 0, 0]), (50, [0, 255, 0]), (150, [0, 0, 255])]
        );
    }

    #[test]
    fn identical_neighbours_merge_into_one_frame() {
        let mut w = writer((8, 8), secs(2), 10);
        for (time, color) in [(0.0, [9, 9, 9]), (0.5, [9, 9, 9]), (1.0, [200, 0, 0])] {
            w.push(time, &solid(8, 8, color), 32, (8, 8)).unwrap();
        }
        let (_, frames) = decode(&w.finish().unwrap());
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].0, 100);
        assert_eq!(frames[1].0, 100);
    }

    #[test]
    fn the_gif_is_as_long_as_the_recording_at_a_fractional_rate() {
        // 15 fps over 2 s: a new colour every tick; the delays sum to 200 cs.
        let mut w = writer((4, 4), secs(2), 15);
        for tick in 0..30u32 {
            let v = (tick * 8) as u8;
            w.push(f64::from(tick) / 15.0, &solid(4, 4, [v, v, v]), 16, (4, 4))
                .unwrap();
        }
        assert!((w.fraction() - 29.0 / 30.0).abs() < 1e-9);
        let (_, frames) = decode(&w.finish().unwrap());
        assert_eq!(frames.len(), 30);
        assert_eq!(frames.iter().map(|f| u32::from(f.0)).sum::<u32>(), 200);
    }

    #[test]
    fn it_scales_down_and_keeps_more_than_256_colours_close() {
        // A 64×64 gradient with thousands of colours, scaled to 32 wide.
        let mut src = Vec::new();
        for y in 0..64u32 {
            for x in 0..64u32 {
                src.extend_from_slice(&[(x * 4) as u8, (y * 4) as u8, ((x + y) * 2) as u8, 255]);
            }
        }
        let p = plan((64, 64), secs(1), options(10, 32)).unwrap();
        let mut w = GifWriter::new(Vec::new(), (64, 64), p).unwrap();
        w.push(0.0, &src, 256, (64, 64)).unwrap();
        let bytes = w.finish().unwrap();
        let (decoder, frames) = decode(&bytes);
        assert_eq!((decoder.width(), decoder.height()), (32, 32));
        assert_eq!(frames.len(), 1);
        // Its first pixel is the mean of the top-left 2×2 block: close to (red 1, green 1, blue 1).
        let px = frames[0].1;
        assert!(px.iter().all(|c| *c < 24), "{px:?}");
    }

    #[test]
    fn a_wrong_sized_picture_is_refused() {
        let mut w = writer((8, 8), secs(1), 10);
        let error = w
            .push(0.0, &solid(4, 4, [0, 0, 0]), 16, (4, 4))
            .unwrap_err();
        assert_eq!(
            error,
            GifError::FrameSize {
                expected: (8, 8),
                got: (4, 4)
            }
        );
        // A truncated buffer is an error too.
        assert_eq!(
            w.push(0.0, &[0; 10], 32, (8, 8)).unwrap_err(),
            GifError::ShortFrame
        );
    }

    #[test]
    fn no_pictures_is_an_error() {
        assert_eq!(
            writer((8, 8), secs(1), 10).finish().unwrap_err(),
            GifError::NoFrames
        );
    }

    #[test]
    fn a_stamp_that_goes_backwards_never_rewinds_the_clock() {
        let mut w = writer((8, 8), secs(2), 10);
        w.push(1.0, &solid(8, 8, [0, 0, 255]), 32, (8, 8)).unwrap();
        w.push(1.5, &solid(8, 8, [0, 255, 0]), 32, (8, 8)).unwrap();
        w.push(1.2, &solid(8, 8, [255, 0, 0]), 32, (8, 8)).unwrap();
        let (_, frames) = decode(&w.finish().unwrap());
        let total: u32 = frames.iter().map(|f| u32::from(f.0)).sum();
        assert_eq!(total, 200);
        assert_eq!(frames[0], (50, [255, 0, 0]));
    }
}
