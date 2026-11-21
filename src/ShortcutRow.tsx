import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardIcon } from "./icons";
import {
  setShortcut,
  shortcutRejection,
  suspendShortcut,
  type ShortcutRejection,
  type ShortcutStatus,
} from "./ipc";
import { t, useLanguage } from "./i18n";
import { shortcutLabel, type Platform } from "./platform";
import { richMessage } from "./richMessage";
import { DEFAULT_ACCELERATOR, acceleratorFromKey, isCancel, rejectionMessage } from "./shortcut";
import { StatusRow } from "./StatusRow";
import type { Tray } from "./platform";

/**
 * The main window's global shortcut row: status, and recording a new shortcut (ADR-030). While
 * recording, Rust releases the current shortcut so its keys reach the page instead of starting
 * a capture; leaving the window ends recording and registers it again.
 */
export function ShortcutRow({
  shortcut,
  platform,
  tray,
  onChange,
}: {
  shortcut: ShortcutStatus;
  platform: Platform;
  tray: Tray;
  onChange: (status: ShortcutStatus) => void;
}) {
  useLanguage();
  const [recording, setRecording] = useState(false);
  const [rejection, setRejection] = useState<ShortcutRejection | null>(null);
  const pending = useRef(false);
  const recordingNow = useRef(false);
  const prompt = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    recordingNow.current = recording;
    if (recording) prompt.current?.focus();
  }, [recording]);

  const stop = useCallback(() => {
    if (!recordingNow.current) return;
    recordingNow.current = false;
    setRecording(false);
    setRejection(null);
    void suspendShortcut(false).then((status) => status && onChange(status));
  }, [onChange]);

  const start = () => {
    setRejection(null);
    setRecording(true);
    void suspendShortcut(true);
  };

  const apply = useCallback(
    async (accelerator: string | null) => {
      if (pending.current) return;
      pending.current = true;
      try {
        const status = await setShortcut(accelerator);
        recordingNow.current = false;
        setRecording(false);
        setRejection(null);
        onChange(status);
      } catch (error) {
        setRejection(shortcutRejection(error));
      } finally {
        pending.current = false;
      }
    },
    [onChange],
  );

  useEffect(() => {
    if (!recording) return;
    const onKey = (event: KeyboardEvent) => {
      // Capturing, so nothing else on the page (or the browser) acts on the keys being recorded.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (isCancel(event)) {
        stop();
        return;
      }
      const accelerator = acceleratorFromKey(event, platform);
      if (accelerator) void apply(accelerator);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
    };
  }, [recording, platform, apply, stop]);

  // Never leave the app without its shortcut, even if the row goes away mid-recording.
  useEffect(
    () => () => {
      if (recordingNow.current) void suspendShortcut(false);
    },
    [],
  );

  const label = shortcutLabel(shortcut.accelerator, platform);
  let value = label;
  let tone: "ok" | "warning" | "neutral" = "ok";
  if (recording) {
    value = t("app.shortcut.recording");
    tone = "neutral";
  } else if (!shortcut.registered) {
    value = t("app.shortcut.unavailable");
    tone = "warning";
  }

  return (
    <StatusRow
      icon={<KeyboardIcon />}
      title={t("app.shortcut.title")}
      value={value}
      tone={tone}
      aside={
        recording ? (
          <button type="button" className="button" onClick={stop}>
            {t("app.shortcut.cancel")}
          </button>
        ) : (
          <button type="button" className="button" onClick={start}>
            {t("app.shortcut.change")}
          </button>
        )
      }
    >
      <div className="status-detail shortcut-detail">
        {recording && (
          <p className="shortcut-recorder" ref={prompt} tabIndex={-1} role="status">
            {richMessage("app.shortcut.prompt", { esc: <kbd>Esc</kbd> })}
          </p>
        )}
        {!recording && !shortcut.registered && (
          <p role="alert">
            <kbd>{label}</kbd>
            {richMessage(
              tray === "menuBar"
                ? "app.shortcut.notRegisteredMenuBar"
                : "app.shortcut.notRegisteredSystemTray",
              { capture: <strong>{t("app.shortcut.trayCapture")}</strong> },
              { reason: shortcut.error ?? t("app.shortcut.noReason") },
            )}
          </p>
        )}
        {rejection && (
          <p className="shortcut-error" role="alert">
            {rejectionMessage(rejection, platform)}
          </p>
        )}
        {!recording && shortcut.accelerator !== DEFAULT_ACCELERATOR && (
          <div className="actions">
            <button type="button" className="button" onClick={() => void apply(null)}>
              {t("app.shortcut.reset", {
                shortcut: shortcutLabel(DEFAULT_ACCELERATOR, platform),
              })}
            </button>
          </div>
        )}
      </div>
    </StatusRow>
  );
}
