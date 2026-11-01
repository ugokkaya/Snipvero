import { useCallback, useEffect, useRef, useState } from "react";
import appIcon from "../src-tauri/icons/128x128@2x.png";
import { ExternalLink } from "./ExternalLink";
import {
  AnnotateIcon,
  CaptureIcon,
  ExportIcon,
  GitHubIcon,
  InfoIcon,
  MenuBarIcon,
  ShieldIcon,
} from "./icons";
import {
  appStatus,
  onCaptureFailed,
  openScreenRecordingSettings,
  restartApp,
  showAbout,
  startCapture,
  type AppStatus,
  type ShortcutStatus,
} from "./ipc";
import { detectPlatform, shortcutLabel } from "./platform";
import { ShortcutRow } from "./ShortcutRow";
import { StatusRow, type Tone } from "./StatusRow";
import { UpdatesRow } from "./Updates";
import { useAppInfo } from "./useAppInfo";
import { useFitWindow } from "./useFitWindow";

const platform = detectPlatform(navigator.userAgent);
const trayName = platform === "macos" ? "menu bar" : "system tray";

const FEATURES = [
  { title: "Capture", text: "Select any screen region.", icon: <CaptureIcon /> },
  { title: "Annotate", text: "Add arrows, rectangles, and text.", icon: <AnnotateIcon /> },
  { title: "Export", text: "Copy to clipboard or save as PNG.", icon: <ExportIcon /> },
] as const;

export function App() {
  const info = useAppInfo();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void appStatus().then(setStatus);
  }, []);

  const shortcutChanged = useCallback((shortcut: ShortcutStatus) => {
    setStatus((current) => current && { ...current, shortcut });
  }, []);

  const layout = useRef<HTMLDivElement>(null);
  useFitWindow(layout);

  useEffect(() => {
    refresh();
    // Permission can change while the window is open (System Settings).
    window.addEventListener("focus", refresh);
    const unlisten = onCaptureFailed((message) => {
      setCaptureError(message);
      refresh();
    });
    return () => {
      window.removeEventListener("focus", refresh);
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const shortcut = status?.shortcut;
  const shortcutText = shortcut ? shortcutLabel(shortcut.accelerator, platform) : null;
  const captureSupported = status?.captureSupported === true;
  const needsPermission = status?.captureSupported === true && !status.screenRecordingAllowed;

  const capture = () => {
    setCaptureError(null);
    void startCapture();
  };

  let permission: { value: string; tone: Tone };
  if (!status) permission = { value: "Checking…", tone: "neutral" };
  else if (!status.captureSupported) permission = { value: "Not available", tone: "neutral" };
  else if (status.screenRecordingAllowed) permission = { value: "Allowed", tone: "ok" };
  else permission = { value: "Not allowed", tone: "warning" };

  return (
    <div className="window" ref={layout}>
      <header className="header">
        <img className="header-icon" src={appIcon} alt="" width={44} height={44} />
        <div className="header-text">
          <h1>Snipvero</h1>
          <p className="subtitle">Screen capture &amp; annotation</p>
        </div>
        {info && <span className="badge">v{info.version}</span>}
      </header>

      <main className="content">
        <section className="primary" aria-label="Capture">
          <button
            type="button"
            className="capture-button"
            onClick={capture}
            disabled={status !== null && !captureSupported}
          >
            <CaptureIcon size={18} />
            <span className="capture-label">Capture Region</span>
            {shortcut?.registered && shortcutText && (
              <kbd className="capture-shortcut" aria-label={`Shortcut ${shortcutText}`}>
                {shortcutText}
              </kbd>
            )}
          </button>
          <p className="hint">
            Freezes every display. Drag to select a region, press <kbd>Esc</kbd> to cancel.
          </p>
        </section>

        {captureError && !needsPermission && (
          <p className="banner" role="alert">
            {captureError}
          </p>
        )}

        <ul className="features" aria-label="Features">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="feature">
              <span className="feature-icon">{feature.icon}</span>
              <h2>{feature.title}</h2>
              <p>{feature.text}</p>
            </li>
          ))}
        </ul>

        <ul className="status" aria-label="Status">
          <StatusRow
            icon={<MenuBarIcon />}
            title={`Runs in the ${trayName}`}
            value="Running"
            tone="ok"
          >
            <p className="status-detail">Closing this window keeps Snipvero running.</p>
          </StatusRow>

          <StatusRow icon={<ShieldIcon />} title="Screen Recording" {...permission}>
            {needsPermission && (
              <div className="status-detail" role="alert">
                <p>
                  Turn on Snipvero in System Settings → Privacy &amp; Security → Screen &amp; System
                  Audio Recording. If capture still fails, restart Snipvero.
                </p>
                <div className="actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => void openScreenRecordingSettings()}
                  >
                    Open System Settings
                  </button>
                  <button type="button" className="button" onClick={() => void restartApp()}>
                    Restart Snipvero
                  </button>
                </div>
              </div>
            )}
            {status && !status.captureSupported && (
              <p className="status-detail">Screen capture is not available on this platform yet.</p>
            )}
          </StatusRow>

          {shortcut && (
            <ShortcutRow
              shortcut={shortcut}
              platform={platform}
              trayName={trayName}
              onChange={shortcutChanged}
            />
          )}

          <UpdatesRow current={info?.version} />
        </ul>
      </main>

      <footer className="footer">
        <span className="footer-version">{info && `Version ${info.version}`}</span>
        <div className="footer-links">
          <button type="button" className="link-button" onClick={() => void showAbout()}>
            <InfoIcon />
            About Snipvero
          </button>
          {info && (
            <ExternalLink link="website" href={info.website} className="footer-link">
              snipvero.app
            </ExternalLink>
          )}
          {info && (
            <ExternalLink link="repository" href={info.repository} className="footer-link">
              <GitHubIcon />
              GitHub
            </ExternalLink>
          )}
        </div>
      </footer>
    </div>
  );
}
