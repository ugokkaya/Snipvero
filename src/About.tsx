import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../src-tauri/icons/128x128@2x.png";
import { ExternalLink } from "./ExternalLink";
import { t, useLanguage } from "./i18n";
import { openLink } from "./ipc";
import { Updates } from "./Updates";
import { useAppInfo } from "./useAppInfo";
import { useFitWindow } from "./useFitWindow";

export const description = () => t("app.about.description");
export const DEVELOPER = "Ugur Can Gokkaya";

/** Shown without the scheme, as people read it. */
const displayUrl = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");

/** The About window (tray menu and main window). Contributors are credited on GitHub. */
export function About() {
  useLanguage();
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
      <p className="about-version">{info && t("app.about.version", { version: info.version })}</p>
      <p className="about-description">{description()}</p>

      <dl className="about-details">
        <div>
          <dt>{t("app.about.developer")}</dt>
          <dd>{DEVELOPER}</dd>
        </div>
        <div>
          <dt>{t("app.about.website")}</dt>
          <dd>
            {info && (
              <ExternalLink link="website" href={info.website}>
                {displayUrl(info.website)}
              </ExternalLink>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("app.about.contact")}</dt>
          <dd>
            {info && (
              <ExternalLink link="support" href={`mailto:${info.supportEmail}`}>
                {info.supportEmail}
              </ExternalLink>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("app.about.sourceCode")}</dt>
          <dd>
            {info && (
              <ExternalLink link="repository" href={info.repository}>
                {displayUrl(info.repository)}
              </ExternalLink>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("app.about.contributors")}</dt>
          <dd>
            {info && (
              <ExternalLink link="contributors" href={info.contributors}>
                {t("app.about.viewOnGitHub")}
              </ExternalLink>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("app.about.license")}</dt>
          <dd>
            {t("app.about.licenseName")} ·{" "}
            <button type="button" className="link-button" onClick={() => void openLink("license")}>
              {t("app.about.viewLicense")}
            </button>
          </dd>
        </div>
      </dl>

      <Updates current={info?.version} />

      <p className="about-copyright">{info?.copyright}</p>
    </main>
  );
}
