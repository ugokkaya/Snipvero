import { useCallback, useEffect, useState } from "react";
import {
  openMicrophoneSettings,
  recordingAudio,
  recordingSetAudio,
  type AudioKind,
  type AudioStatus,
} from "../ipc";
import { t, useLanguage } from "../i18n";
import { microphoneView } from "./audio";

const errorMessage = (error: unknown) =>
  typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : t("recording.actionFailed");

/**
 * The two sound switches of a recording, both off by default and remembered by Rust. Nothing
 * asks for a permission until the microphone is switched on, and a microphone that the system
 * does not allow stays off, with the way to allow it.
 */
export function RecordingAudio() {
  useLanguage();
  const [audio, setAudio] = useState<AudioStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The user just tried to switch the microphone on and the system did not allow it.
  const [refused, setRefused] = useState(false);

  const refresh = useCallback(() => {
    recordingAudio().then(setAudio, (reason: unknown) => setError(errorMessage(reason)));
  }, []);

  useEffect(() => {
    refresh();
    // The permission can change while the window is open (System Settings).
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  if (!audio?.supported) return null;
  const microphone = microphoneView(audio);

  const change = async (kind: AudioKind, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await recordingSetAudio(kind, enabled);
      setAudio(next);
      if (kind === "microphone") setRefused(enabled && !microphoneView(next).on);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const showGuidance = microphone.guidance !== null && (refused || audio.microphone);
  return (
    <div className="audio">
      <fieldset className="audio-options" disabled={busy}>
        <legend>{t("recording.audio.legend")}</legend>
        <label className="audio-option">
          <input
            type="checkbox"
            checked={audio.system}
            onChange={(event) => void change("system", event.target.checked)}
          />
          <span>{t("recording.audio.system")}</span>
        </label>
        <label className="audio-option">
          <input
            type="checkbox"
            checked={microphone.on}
            disabled={!microphone.available}
            onChange={(event) => void change("microphone", event.target.checked)}
          />
          <span>{t("recording.audio.microphone")}</span>
        </label>
      </fieldset>
      <p className="hint">{t("recording.audio.hint")}</p>
      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      {showGuidance && (
        <div className="audio-guidance" role="alert">
          {microphone.guidance === "restricted" ? (
            <p>{t("recording.audio.restricted")}</p>
          ) : (
            <>
              <p>{t("recording.audio.denied")}</p>
              <div className="actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => void openMicrophoneSettings()}
                >
                  {t("recording.audio.openSettings")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
