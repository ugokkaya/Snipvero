import { useEffect, useRef, useState } from "react";
import {
  onRecordingExportProgress,
  recordingCancelGifExport,
  recordingExportGif,
  recordingGifPlan,
  type GifOptions,
  type GifPlan,
  type RecordingStatus,
} from "../ipc";
import { formatBytes } from "./format";
import { formatEstimate, GIF_FPS_CHOICES, gifFileName, gifWidthChoices, percent } from "./gif";

const errorMessage = (error: unknown) =>
  typeof error === "string" ? error : error instanceof Error ? error.message : "Export failed.";

type Phase = "idle" | "choosing" | "running" | "cancelling";

/**
 * The GIF export of a finished recording: frame rate and width, a size estimate, then the save
 * dialog, progress and Cancel. The limits (15 fps, 800 px, 60 seconds of video) are Rust's; the
 * panel asks `recording_gif_plan` and shows its answer, including the reason when a recording is
 * too long. The MP4 is never touched. `onBusy` tells the window to hold its other buttons.
 */
export function GifExport({
  id,
  status,
  onBusy,
  onClose,
}: {
  id: number;
  status: RecordingStatus;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const [fps, setFps] = useState(status.gifDefaultFps);
  const [width, setWidth] = useState(status.gifDefaultWidth);
  const [plan, setPlan] = useState<{ plan: GifPlan } | { error: string } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [fraction, setFraction] = useState(0);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  // Whether Cancel was pressed, to tell a cancelled export from a dismissed save dialog.
  const cancelRequested = useRef(false);

  // What the options produce, asked again whenever one changes.
  useEffect(() => {
    let stale = false;
    const options: GifOptions = { fps, width };
    recordingGifPlan(id, options).then(
      (value) => !stale && setPlan({ plan: value }),
      (error: unknown) => !stale && setPlan({ error: errorMessage(error) }),
    );
    return () => {
      stale = true;
    };
  }, [id, fps, width]);

  useEffect(() => {
    const unlisten = onRecordingExportProgress((progress) => {
      if (progress.id !== id || progress.phase !== "running") return;
      setPhase((current) => (current === "choosing" ? "running" : current));
      setFraction(progress.fraction);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [id]);

  const working = phase !== "idle";
  const exporting = () => {
    setPhase("choosing");
    setFraction(0);
    setResult(null);
    cancelRequested.current = false;
    onBusy(true);
    recordingExportGif(id, gifFileName(new Date()), { fps, width })
      .then((done) => {
        if (done.outcome === "done") {
          setResult({
            text: `GIF saved (${formatBytes(done.bytes)}, ${done.frames} ${
              done.frames === 1 ? "frame" : "frames"
            }).`,
            error: false,
          });
        } else if (cancelRequested.current) {
          setResult({ text: "GIF export cancelled.", error: false });
        }
      })
      .catch((error: unknown) => setResult({ text: errorMessage(error), error: true }))
      .finally(() => {
        setPhase("idle");
        onBusy(false);
      });
  };

  const planned = plan && "plan" in plan ? plan.plan : null;
  const widths = gifWidthChoices(status.gifMaxWidth, status.gifDefaultWidth);
  return (
    <section className="review-gif" aria-label="Export as GIF">
      <h2>Export as GIF</h2>
      <div className="review-gif-row">
        <label>
          Frame rate
          <select
            value={fps}
            disabled={working}
            onChange={(event) => setFps(Number(event.target.value))}
          >
            {GIF_FPS_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice} fps
              </option>
            ))}
          </select>
        </label>
        <label>
          Width
          <select
            value={width}
            disabled={working}
            onChange={(event) => setWidth(Number(event.target.value))}
          >
            {widths.map((choice) => (
              <option key={choice} value={choice}>
                {choice} px
              </option>
            ))}
          </select>
        </label>
      </div>
      {planned && (
        <p className="review-note">
          {planned.width} × {planned.height} px, {formatEstimate(planned.estimatedBytes)}.
        </p>
      )}
      {plan && "error" in plan && (
        <p className="banner" role="alert">
          {plan.error}
        </p>
      )}
      {working && (
        <div className="review-gif-progress">
          <progress
            max={100}
            // Without a value while the save dialog is open: nothing is running yet.
            {...(phase === "choosing" ? {} : { value: percent(fraction) })}
            aria-label="GIF export progress"
          />
          <span>
            {phase === "choosing"
              ? "Choose where to save…"
              : phase === "cancelling"
                ? "Cancelling…"
                : `${percent(fraction)} %`}
          </span>
        </div>
      )}
      {result && (
        <p
          className={result.error ? "banner" : "review-note"}
          role={result.error ? "alert" : "status"}
        >
          {result.text}
        </p>
      )}
      <div className="review-actions">
        {phase === "running" || phase === "cancelling" ? (
          <button
            type="button"
            className="button"
            disabled={phase === "cancelling"}
            onClick={() => {
              cancelRequested.current = true;
              setPhase("cancelling");
              void recordingCancelGifExport(id);
            }}
          >
            Cancel export
          </button>
        ) : (
          <>
            <button
              type="button"
              className="review-save"
              disabled={working || planned === null}
              onClick={exporting}
            >
              Export…
            </button>
            <button type="button" className="button" disabled={working} onClick={onClose}>
              Close
            </button>
          </>
        )}
      </div>
    </section>
  );
}
