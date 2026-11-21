import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { About } from "./About";
import { App } from "./App";
import { languageGet, onLanguageChanged } from "./ipc";
import { languageFromTag, setLanguage, useLanguage } from "./i18n";
import { Overlay } from "./overlay/Overlay";
import { RecordingReview } from "./recording/RecordingReview";
import { routeFor } from "./route";
import "./App.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

const route = routeFor(getCurrentWindow().label);
document.documentElement.classList.add(`${route.view}-root`);

/**
 * Renders the view again when the language changes. `t()` reads the current language, so the
 * tree needs no remount (an open overlay keeps its state).
 */
function LanguageRoot() {
  useLanguage();
  return route.view === "overlay" ? (
    <Overlay index={route.index} />
  ) : route.view === "about" ? (
    <About />
  ) : route.view === "recording" ? (
    <RecordingReview />
  ) : (
    <App />
  );
}

// The language is known before the first paint, so the window never flashes in the wrong one.
// Rust answers at once; the webview's own locale is only a fallback if the command fails.
async function startLanguage(): Promise<void> {
  try {
    setLanguage((await languageGet()).language);
  } catch {
    setLanguage(languageFromTag(navigator.language));
  }
  void onLanguageChanged(setLanguage);
}

void startLanguage().then(() => {
  createRoot(root).render(
    <StrictMode>
      <LanguageRoot />
    </StrictMode>,
  );
});
