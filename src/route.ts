import { ABOUT_LABEL, OVERLAY_LABEL_PREFIX } from "./ipc";

export type Route = { view: "main" } | { view: "about" } | { view: "overlay"; index: number };

/** Every window loads index.html; its label decides what it shows. */
export function routeFor(label: string): Route {
  if (label === ABOUT_LABEL) return { view: "about" };
  if (label.startsWith(OVERLAY_LABEL_PREFIX)) {
    const index = label.slice(OVERLAY_LABEL_PREFIX.length);
    if (/^\d+$/.test(index)) return { view: "overlay", index: Number(index) };
  }
  return { view: "main" };
}
