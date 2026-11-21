import type { appEn } from "./app.en";

// Turkish messages of the main window, About, updates and shared helpers.
// Every English key needs a Turkish message (checked by tsc).
export const appTr: Record<keyof typeof appEn, string> = {
  "app.language.title": "Dil",
  "app.language.system": "Sistem varsayılanı",
  "app.language.en": "English",
  "app.language.tr": "Türkçe",
  "app.language.failed": "Dil değiştirilemedi.",
};
