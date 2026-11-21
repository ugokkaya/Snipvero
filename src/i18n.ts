// Interface language (ADR-039): English and Turkish.
//
// Rust owns the choice (`language_get` / `language_set`); this module holds the current language
// for the page and returns messages from the catalogues in `locales/`. `t()` reads the current
// language when it is called, so a component shows the new language the next time it renders:
// `LanguageRoot` (main.tsx) renders the whole tree again when the language changes.
import { useSyncExternalStore } from "react";
import { appEn } from "./locales/app.en";
import { appTr } from "./locales/app.tr";
import { overlayEn } from "./locales/overlay.en";
import { overlayTr } from "./locales/overlay.tr";
import { recordingEn } from "./locales/recording.en";
import { recordingTr } from "./locales/recording.tr";

export type Language = "en" | "tr";

export const en = { ...appEn, ...overlayEn, ...recordingEn } as const;
export type MessageKey = keyof typeof en;
export const tr: Record<MessageKey, string> = { ...appTr, ...overlayTr, ...recordingTr };

const catalogues: Record<Language, Record<MessageKey, string>> = { en, tr };

let current: Language = "en";
const listeners = new Set<() => void>();

export function getLanguage(): Language {
  return current;
}

export function setLanguage(language: Language): void {
  if (language === current) return;
  current = language;
  if (typeof document !== "undefined") document.documentElement.lang = language;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders the calling component when the language changes. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

export type Params = Record<string, string | number>;

/** Replaces `{name}` in `template` with `params.name`; an unknown name is left as it is. */
export function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** The message `key` in the current language. */
export function t(key: MessageKey, params?: Params): string {
  return format(catalogues[current][key], params);
}

/** `"tr"` for a Turkish system language tag such as `tr-TR`, else `"en"`. */
export function languageFromTag(tag: string): Language {
  return /^tr(-|$)/i.test(tag) ? "tr" : "en";
}
