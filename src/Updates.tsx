import { useCallback, useEffect, useReducer, useRef, type ReactNode } from "react";
import { t, useLanguage } from "./i18n";
import { UpdateIcon } from "./icons";
import {
  cancelUpdate,
  checkForUpdate,
  installUpdate,
  onUpdateCheckRequested,
  updateFailure,
} from "./ipc";
import { IDLE, failureMessage, formatBytes, reduce, retryAction, type UpdateView } from "./update";

export const privacyNote = () => t("app.update.privacy");
export const restartNote = () => t("app.update.restartNote");

interface Controls {
  view: UpdateView;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

/**
 * Check for Updates (ADR-028). Nothing is requested until the user clicks, and nothing is
 * downloaded or installed until they agree to restart.
 */
function useUpdates(): Controls {
  const [view, dispatch] = useReducer(reduce, IDLE);

  const check = useCallback(async () => {
    dispatch({ type: "check" });
    try {
      dispatch({ type: "checked", result: await checkForUpdate() });
    } catch (error) {
      dispatch({ type: "failed", failure: updateFailure(error) });
    }
  }, []);

  const install = useCallback(async () => {
    dispatch({ type: "install" });
    try {
      // Resolves once the app is restarting; progress events move the view along before that.
      await installUpdate((progress) => dispatch({ type: "progress", progress }));
    } catch (error) {
      dispatch({ type: "failed", failure: updateFailure(error) });
    }
  }, []);

  return { view, check, install, dismiss: () => dispatch({ type: "dismiss" }) };
}

/** Everything after the first click: result, notes, consent, progress and failures. */
function Details({
  controls: { view, check, install, dismiss },
  current,
  checkAgain,
}: {
  controls: Controls;
  current: string | undefined;
  /** Whether "Check Again" belongs here (About) or next to the row's title (main window). */
  checkAgain: boolean;
}) {
  useLanguage();
  const retry = retryAction(view);
  switch (view.step) {
    case "idle":
    case "checking":
      return null;
    case "upToDate":
      return (
        <>
          <p className="update-status">{t("app.update.upToDate", { current: view.current })}</p>
          {checkAgain && (
            <button type="button" className="button" onClick={() => void check()}>
              {t("app.update.checkAgain")}
            </button>
          )}
        </>
      );
    case "available":
      return (
        <>
          <p className="update-status">
            <strong>{t("app.update.available", { version: view.version })}</strong>{" "}
            {t("app.update.youHave", { current: view.current })}
          </p>
          {view.notes && (
            // Plain text: notes come from the network and are never interpreted as markup.
            <div
              className="update-notes"
              role="region"
              aria-label={t("app.update.releaseNotes")}
              tabIndex={0}
            >
              {view.notes}
            </div>
          )}
          <p className="update-note">{restartNote()}</p>
          <div className="actions">
            <button type="button" className="button button-primary" onClick={() => void install()}>
              {t("app.update.download")}
            </button>
            <button type="button" className="button" onClick={dismiss}>
              {t("app.update.notNow")}
            </button>
          </div>
        </>
      );
    case "downloading":
      return (
        <>
          <progress
            className="update-progress"
            aria-label={t("app.update.progress")}
            value={view.received}
            {...(view.total ? { max: view.total } : {})}
          />
          <p className="update-note">
            {view.total
              ? t("app.update.downloadingOf", {
                  version: view.version,
                  received: formatBytes(view.received),
                  total: formatBytes(view.total),
                })
              : t("app.update.downloading", {
                  version: view.version,
                  received: formatBytes(view.received),
                })}
          </p>
          <button type="button" className="button" onClick={() => void cancelUpdate()}>
            {t("app.update.cancel")}
          </button>
        </>
      );
    case "installing":
      return (
        <p className="update-status">{t("app.update.installing", { version: view.version })}</p>
      );
    case "restarting":
      return <p className="update-status">{t("app.update.restarting")}</p>;
    case "failed":
      return (
        <>
          <p className="update-error" role="alert">
            {failureMessage(view.failure)}
          </p>
          {view.failure !== "unavailable" && current && (
            <p className="update-note">{t("app.update.keepsWorking", { current })}</p>
          )}
          {retry && (
            <button
              type="button"
              className="button"
              onClick={() => void (retry === "install" ? install() : check())}
            >
              {t("app.update.tryAgain")}
            </button>
          )}
        </>
      );
  }
}

/** The About window's section, centred under the details. */
export function Updates({ current }: { current: string | undefined }) {
  useLanguage();
  const controls = useUpdates();
  const { view, check } = controls;
  return (
    <section className="about-update" aria-label={t("app.update.title")} aria-live="polite">
      {view.step === "idle" && (
        <>
          <button type="button" className="button" onClick={() => void check()}>
            {t("app.update.check")}
          </button>
          <p className="update-note">{privacyNote()}</p>
        </>
      )}
      {view.step === "checking" && (
        <button type="button" className="button" disabled>
          {t("app.update.checking")}
        </button>
      )}
      <Details controls={controls} current={current} checkAgain />
    </section>
  );
}

/** A check may start over a result, never over a check or a download that is running. */
const mayStartCheck = (view: UpdateView) =>
  view.step === "idle" ||
  view.step === "upToDate" ||
  view.step === "available" ||
  view.step === "failed";

/**
 * The main window's status row. The menu bar's Check for Updates… starts a check here, because
 * this page is always loaded.
 */
export function UpdatesRow({ current }: { current: string | undefined }) {
  useLanguage();
  const controls = useUpdates();
  const { view, check } = controls;
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  }, [view]);

  useEffect(() => {
    const pending = onUpdateCheckRequested(() => {
      if (mayStartCheck(latest.current)) void check();
    });
    return () => void pending.then((unlisten) => unlisten());
  }, [check]);

  let aside: ReactNode = null;
  if (view.step === "idle" || view.step === "upToDate") {
    aside = (
      <button type="button" className="button" onClick={() => void check()}>
        {view.step === "idle" ? t("app.update.check") : t("app.update.checkAgain")}
      </button>
    );
  } else if (view.step === "checking") {
    aside = <span className="status-value">{t("app.update.checking")}</span>;
  }

  return (
    <li className="status-row update-row" aria-label={t("app.update.title")}>
      <span className="status-icon">
        <UpdateIcon />
      </span>
      <div className="status-body">
        <div className="status-line">
          <span className="status-title">{t("app.update.title")}</span>
          {aside}
        </div>
        <div className="status-detail update-detail" aria-live="polite">
          {view.step === "idle" && <p>{privacyNote()}</p>}
          <Details controls={controls} current={current} checkAgain={false} />
        </div>
      </div>
    </li>
  );
}
