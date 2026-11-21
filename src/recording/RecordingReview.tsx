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
import { t, useLanguage } from "../i18n";
import { soundLabel } from "./audio";
import { GifExport } from "./GifExport";
import { formatBytes, formatClock, recordingFileName } from "./format";

const errorMessage = (error: unknown) =>
  typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : t("recording.actionFailed");

type Action = "save" | "discard" | "copy-file" | "copy-path";

/**
 * The window after a recording: play it back, then Save, copy it or Discard it. Closing the window
 * keeps the recording; only Save, Discard or quitting deletes it (ADR-037). The page knows the
 * recording by an opaque id, never by a path.
 */
export function RecordingReview() {
  useLanguage();
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
            ? t("recording.review.inProgress")
            : t("recording.review.none")}
        </p>
      </main>
    );
  }
  // Keyed, so a new recording starts with no old message and a fresh player.
  return <Review key={id} id={id} status={status} />;
}

function Review({ id, status }: { id: number; status: RecordingStatus }) {
  useLanguage();
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  // A GIF export reads the file: nothing else may delete or save it meanwhile.
  const [exportingGif, setExportingGif] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);

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

  const disabled = busy !== null || exportingGif;
  return (
    <main className="review">
      <h1>{t("recording.review.title")}</h1>
      <div className="review-player">
        {previewFailed ? (
          <p className="review-empty">{t("recording.review.previewFailed")}</p>
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
          <dt>{t("recording.review.size")}</dt>
          <dd>
            {status.width} × {status.height} px
          </dd>
        </div>
        <div>
          <dt>{t("recording.review.length")}</dt>
          <dd>{formatClock(status.durationMs ?? 0)}</dd>
        </div>
        <div>
          <dt>{t("recording.review.sound")}</dt>
          <dd>{soundLabel(status.systemAudio, status.microphone)}</dd>
        </div>
        <div>
          <dt>{t("recording.review.file")}</dt>
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
          {t("recording.review.save")}
        </button>
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() =>
            void run("copy-file", () => recordingCopy(id, "file"), t("recording.review.fileCopied"))
          }
        >
          {t("recording.review.copyFile")}
        </button>
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() =>
            void run("copy-path", () => recordingCopy(id, "path"), t("recording.review.pathCopied"))
          }
        >
          {t("recording.review.copyPath")}
        </button>
        <button
          type="button"
          className="button"
          disabled={disabled || gifOpen}
          onClick={() => setGifOpen(true)}
        >
          {t("recording.review.exportGif")}
        </button>
        <button
          type="button"
          className="button review-discard"
          disabled={disabled}
          onClick={() => void run("discard", () => recordingDiscard(id))}
        >
          {t("recording.review.discard")}
        </button>
      </div>
      {gifOpen && (
        <GifExport
          id={id}
          status={status}
          onBusy={setExportingGif}
          onClose={() => setGifOpen(false)}
        />
      )}
      <p className="review-hint">{t("recording.review.hint")}</p>
    </main>
  );
}
