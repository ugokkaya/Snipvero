import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../src-tauri/icons/128x128@2x.png";
import { ExternalLink } from "./ExternalLink";
import { openLink } from "./ipc";
import { Updates } from "./Updates";
import { useAppInfo } from "./useAppInfo";
import { useFitWindow } from "./useFitWindow";

export const DESCRIPTION =
  "A lightweight, open-source screenshot and annotation application for macOS.";
export const DEVELOPER = "Ugur Can Gokkaya";

/** Shown without the scheme, as people read it. */
const displayUrl = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");

/** The About window (tray menu and main window). Contributors are credited on GitHub. */
export function About() {
  const info = useAppInfo();
  const layout = useRef<HTMLElement>(null);
  useFitWindow(layout);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void getCurrentWindow().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="about" ref={layout}>
      <img className="about-icon" src={appIcon} alt="" width={88} height={88} />
      <h1>{info?.name ?? "Snipvero"}</h1>
      <p className="about-version">{info && `Version ${info.version}`}</p>
      <p className="about-description">{DESCRIPTION}</p>

      <dl className="about-details">
        <div>
          <dt>Developer</dt>
          <dd>{DEVELOPER}</dd>
        </div>
        <div>
          <dt>Source Code</dt>
          <dd>
            {info && (
              <ExternalLink link="repository" href={info.repository}>
                {displayUrl(info.repository)}
              </ExternalLink>
            )}
          </dd>
        </div>
        <div>
          <dt>Contributors</dt>
          <dd>
            {info && (
              <ExternalLink link="contributors" href={info.contributors}>
                View on GitHub
              </ExternalLink>
            )}
          </dd>
        </div>
        <div>
          <dt>License</dt>
          <dd>
            MIT License ·{" "}
            <button type="button" className="link-button" onClick={() => void openLink("license")}>
              View
            </button>
          </dd>
        </div>
      </dl>

      <Updates current={info?.version} />

      <p className="about-copyright">{info?.copyright}</p>
    </main>
  );
}
