import { useCallback, useEffect, useRef, useState } from "react";
import appIcon from "../src-tauri/icons/128x128@2x.png";
import { ExternalLink } from "./ExternalLink";
import { LanguageRow } from "./LanguageRow";
import {
  AnnotateIcon,
  CaptureIcon,
  ExportIcon,
  GitHubIcon,
  InfoIcon,
  MenuBarIcon,
  RecordIcon,
  ShieldIcon,
} from "./icons";
import {
  appStatus,
  onCaptureFailed,
  onRecordingFailed,
  openScreenRecordingSettings,
  restartApp,
  showAbout,
  startCapture,
  startRecording,
  type AppStatus,
  type ShortcutStatus,
} from "./ipc";
import { t, useLanguage } from "./i18n";
import { detectPlatform, shortcutLabel, type Tray } from "./platform";
import { richMessage } from "./richMessage";
import { RecordingAudio } from "./recording/RecordingAudio";
import { ShortcutRow } from "./ShortcutRow";
import { StatusRow, type Tone } from "./StatusRow";
import { UpdatesRow } from "./Updates";
import { useAppInfo } from "./useAppInfo";
import { useFitWindow } from "./useFitWindow";

const platform = detectPlatform(navigator.userAgent);
const tray: Tray = platform === "macos" ? "menuBar" : "systemTray";

const features = () =>
  [
    {
      id: "capture",
      title: t("app.features.capture.title"),
      text: t("app.features.capture.text"),
      icon: <CaptureIcon />,
    },
    {
      id: "annotate",
      title: t("app.features.annotate.title"),
      text: t("app.features.annotate.text"),
      icon: <AnnotateIcon />,
    },
    {
      id: "export",
      title: t("app.features.export.title"),
      text: t("app.features.export.text"),
      icon: <ExportIcon />,
    },
  ] as const;

export function App() {
  useLanguage();
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
    const failed = (message: string) => {
      setCaptureError(message);
      refresh();
    };
    const unlisten = [onCaptureFailed(failed), onRecordingFailed(failed)];
    return () => {
      window.removeEventListener("focus", refresh);
      for (const pending of unlisten) void pending.then((fn) => fn());
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

  const record = () => {
    setCaptureError(null);
    void startRecording();
  };

  let permission: { value: string; tone: Tone };
  if (!status) permission = { value: t("app.permission.checking"), tone: "neutral" };
  else if (!status.captureSupported)
    permission = { value: t("app.permission.notAvailable"), tone: "neutral" };
  else if (status.screenRecordingAllowed)
    permission = { value: t("app.permission.allowed"), tone: "ok" };
  else permission = { value: t("app.permission.notAllowed"), tone: "warning" };

  return (
    <div className="window" ref={layout}>
      <header className="header">
        <img className="header-icon" src={appIcon} alt="" width={44} height={44} />
        <div className="header-text">
          <h1>Snipvero</h1>
          <p className="subtitle">{t("app.subtitle")}</p>
        </div>
        {info && <span className="badge">v{info.version}</span>}
      </header>

      <main className="content">
        <section className="primary" aria-label={t("app.capture.section")}>
          <button
            type="button"
            className="capture-button"
            onClick={capture}
            disabled={status !== null && !captureSupported}
          >
            <CaptureIcon size={18} />
            <span className="capture-label">{t("app.capture.button")}</span>
            {shortcut?.registered && shortcutText && (
              <kbd
                className="capture-shortcut"
                aria-label={t("app.capture.shortcutLabel", { shortcut: shortcutText })}
              >
                {shortcutText}
              </kbd>
            )}
          </button>
          <p className="hint">{richMessage("app.capture.hint", { esc: <kbd>Esc</kbd> })}</p>
          <button
            type="button"
            className="record-button"
            onClick={record}
            disabled={status !== null && !captureSupported}
          >
            <RecordIcon size={16} />
            {t("app.record.button")}
          </button>
          <p className="hint">
            {t("app.record.hint", {
              shortcut:
                shortcut?.registered && shortcutText
                  ? t("app.record.orShortcut", { shortcut: shortcutText })
                  : "",
            })}
          </p>
          {captureSupported && <RecordingAudio />}
        </section>

        {captureError && !needsPermission && (
          <p className="banner" role="alert">
            {captureError}
          </p>
        )}

        <ul className="features" aria-label={t("app.features.label")}>
          {features().map((feature) => (
            <li key={feature.id} className="feature">
              <span className="feature-icon">{feature.icon}</span>
              <h2>{feature.title}</h2>
              <p>{feature.text}</p>
            </li>
          ))}
        </ul>

        <ul className="status" aria-label={t("app.status.label")}>
          <StatusRow
            icon={<MenuBarIcon />}
            title={t(
              tray === "menuBar" ? "app.status.runsInMenuBar" : "app.status.runsInSystemTray",
            )}
            value={t("app.status.running")}
            tone="ok"
          >
            <p className="status-detail">{t("app.status.keepsRunning")}</p>
          </StatusRow>

          <StatusRow icon={<ShieldIcon />} title={t("app.permission.title")} {...permission}>
            {needsPermission && (
              <div className="status-detail" role="alert">
                <p>{t("app.permission.help")}</p>
                <div className="actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => void openScreenRecordingSettings()}
                  >
                    {t("app.permission.openSettings")}
                  </button>
                  <button type="button" className="button" onClick={() => void restartApp()}>
                    {t("app.permission.restart")}
                  </button>
                </div>
              </div>
            )}
            {status && !status.captureSupported && (
              <p className="status-detail">{t("app.permission.unsupported")}</p>
            )}
          </StatusRow>

          {shortcut && (
            <ShortcutRow
              shortcut={shortcut}
              platform={platform}
              tray={tray}
              onChange={shortcutChanged}
            />
          )}

          <LanguageRow />

          <UpdatesRow current={info?.version} />
        </ul>
      </main>

      <footer className="footer">
        <span className="footer-version">
          {info && t("app.footer.version", { version: info.version })}
        </span>
        <div className="footer-links">
          <button type="button" className="link-button" onClick={() => void showAbout()}>
            <InfoIcon />
            {t("app.footer.about")}
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
