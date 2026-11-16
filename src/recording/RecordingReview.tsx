import { useCallback, useEffect, useState } from "react";
import {
  onRecordingState,
  recordingCopy,
  recordingDiscard,
  recordingSave,
  recordingSource,
  recordingStatus,
  type RecordingStatus,
} from "../ipc";
import { soundLabel } from "./audio";
import { formatBytes, formatClock, recordingFileName } from "./format";

const errorMessage = (error: unknown) =>
  typeof error === "string" ? error : error instanceof Error ? error.message : "Action failed.";

type Action = "save" | "discard" | "copy-file" | "copy-path";

/**
 * The window after a recording: play it back, then Save, copy it or Discard it. Closing the window
 * keeps the recording; only Save, Discard or quitting deletes it (ADR-037). The page knows the
 * recording by an opaque id, never by a path.
 */
export function RecordingReview() {
  const [status, setStatus] = useState<RecordingStatus | null>(null);

  useEffect(() => {
    const unlisten = onRecordingState(setStatus);
    // Subscribe first, then read: a change between the two is not lost.
    void unlisten.then(() => recordingStatus().then(setStatus));
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const id = status?.phase === "finished" ? status.id : null;
  if (!status || id === null) {
    return (
      <main className="review">
        <p className="review-empty">
          {status?.phase === "recording" || status?.phase === "stopping"
            ? "Recording in progress. Stop it from the menu bar."
            : "There is no recording to review."}
        </p>
      </main>
    );
  }
  // Keyed, so a new recording starts with no old message and a fresh player.
  return <Review key={id} id={id} status={status} />;
}

function Review({ id, status }: { id: number; status: RecordingStatus }) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);

  const run = useCallback(async (action: Action, work: () => Promise<unknown>, done?: string) => {
    setBusy(action);
    setMessage(null);
    try {
      await work();
      if (done) setMessage({ text: done, error: false });
    } catch (error) {
      setMessage({ text: errorMessage(error), error: true });
    } finally {
      setBusy(null);
    }
  }, []);

  const disabled = busy !== null;
  return (
    <main className="review">
      <h1>Recording</h1>
      <div className="review-player">
        {previewFailed ? (
          <p className="review-empty">The preview could not be played. You can still save it.</p>
        ) : (
          <video
            src={recordingSource(id)}
            controls
            preload="metadata"
            onError={() => setPreviewFailed(true)}
          />
        )}
      </div>
      <dl className="review-details">
        <div>
          <dt>Size</dt>
          <dd>
            {status.width} × {status.height} px
          </dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{formatClock(status.durationMs ?? 0)}</dd>
        </div>
        <div>
          <dt>Sound</dt>
          <dd>{soundLabel(status.systemAudio, status.microphone)}</dd>
        </div>
        <div>
          <dt>File</dt>
          <dd>{formatBytes(status.bytes)}</dd>
        </div>
      </dl>
      {status.notice && <p className="review-notice">{status.notice}</p>}
      {message && (
        <p
          className={message.error ? "banner" : "review-note"}
          role={message.error ? "alert" : "status"}
        >
          {message.text}
        </p>
      )}
      <div className="review-actions">
        <button
          type="button"
          className="review-save"
          disabled={disabled}
          onClick={() => void run("save", () => recordingSave(id, recordingFileName(new Date())))}
        >
          Save…
        </button>
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => void run("copy-file", () => recordingCopy(id, "file"), "File copied.")}
        >
          Copy File
        </button>
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => void run("copy-path", () => recordingCopy(id, "path"), "Path copied.")}
        >
          Copy Path
        </button>
        <button
          type="button"
          className="button"
          disabled
          title="Exporting a recording as a GIF is not available yet."
        >
          Export as GIF…
        </button>
        <button
          type="button"
          className="button review-discard"
          disabled={disabled}
          onClick={() => void run("discard", () => recordingDiscard(id))}
        >
          Discard
        </button>
      </div>
      <p className="review-hint">
        The recording is a temporary file. Copies of it, and of its path, only last until you save,
        discard it or quit Snipvero.
      </p>
    </main>
  );
}
