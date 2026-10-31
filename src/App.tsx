import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import appIcon from "../src-tauri/icons/128x128@2x.png";
import { ExternalLink } from "./ExternalLink";
import {
  AnnotateIcon,
  CaptureIcon,
  ExportIcon,
  GitHubIcon,
  InfoIcon,
  KeyboardIcon,
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
} from "./ipc";
import { detectPlatform, shortcutLabel } from "./platform";
import { useAppInfo } from "./useAppInfo";
import { useFitWindow } from "./useFitWindow";

const platform = detectPlatform(navigator.userAgent);
const trayName = platform === "macos" ? "menu bar" : "system tray";

const FEATURES = [
  { title: "Capture", text: "Select any screen region.", icon: <CaptureIcon /> },
  { title: "Annotate", text: "Add arrows, rectangles, and text.", icon: <AnnotateIcon /> },
  { title: "Export", text: "Copy to clipboard or save as PNG.", icon: <ExportIcon /> },
] as const;

type Tone = "ok" | "warning" | "neutral";

function StatusRow(props: {
  icon: ReactNode;
  title: string;
  value: string;
  tone: Tone;
  children?: ReactNode;
}) {
  return (
    <li className="status-row">
      <span className="status-icon">{props.icon}</span>
      <div className="status-body">
        <div className="status-line">
          <span className="status-title">{props.title}</span>
          <span className="status-value" data-tone={props.tone}>
            <span className="status-dot" aria-hidden="true" />
            {props.value}
          </span>
        </div>
        {props.children}
      </div>
    </li>
  );
}

export function App() {
  const info = useAppInfo();
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void appStatus().then(setStatus);
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

          {shortcut && shortcutText && (
            <StatusRow
              icon={<KeyboardIcon />}
              title="Global shortcut"
              value={shortcut.registered ? shortcutText : "Unavailable"}
              tone={shortcut.registered ? "ok" : "warning"}
            >
              {!shortcut.registered && (
                <p className="status-detail" role="alert">
                  <kbd>{shortcutText}</kbd> could not be registered, probably because another app
                  uses it ({shortcut.error}). Use <strong>Capture</strong> in the {trayName}{" "}
                  instead.
                </p>
              )}
            </StatusRow>
          )}
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
