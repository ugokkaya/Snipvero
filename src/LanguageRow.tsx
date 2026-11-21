import { useEffect, useState } from "react";
import { GlobeIcon } from "./icons";
import { languageGet, languageSet, type LanguageInfo } from "./ipc";
import { t, useLanguage, type Language } from "./i18n";
import { StatusRow } from "./StatusRow";

const SYSTEM = "system";

/** The main window's interface language row: follow the system, or English, or Turkish. */
export function LanguageRow() {
  useLanguage();
  const [info, setInfo] = useState<LanguageInfo | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void languageGet().then(setInfo, () => undefined);
  }, []);

  const choose = (value: string) => {
    setFailed(false);
    const setting = value === SYSTEM ? null : (value as Language);
    languageSet(setting).then(setInfo, () => setFailed(true));
  };

  return (
    <StatusRow
      icon={<GlobeIcon />}
      title={t("app.language.title")}
      value=""
      tone="neutral"
      aside={
        <select
          className="language-select"
          aria-label={t("app.language.title")}
          value={info?.setting ?? SYSTEM}
          disabled={info === null}
          onChange={(event) => choose(event.target.value)}
        >
          <option value={SYSTEM}>{t("app.language.system")}</option>
          <option value="en">{t("app.language.en")}</option>
          <option value="tr">{t("app.language.tr")}</option>
        </select>
      }
    >
      {failed && (
        <p className="status-detail" role="alert">
          {t("app.language.failed")}
        </p>
      )}
    </StatusRow>
  );
}
