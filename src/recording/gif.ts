// Pure helpers for the GIF export panel of the review window (ADR-037, task 4).
import { formatBytes } from "./format";

/**
 * Frame rates offered. The limit (15) and the default (10) are Rust's: `gif::MAX_FPS` rejects
 * anything above it and the status carries the default; keep this list within the limit.
 */
export const GIF_FPS_CHOICES = [5, 10, 15] as const;

/** Widths offered for a recording: its default (1×) and its maximum, plus common smaller steps. */
export function gifWidthChoices(maxWidth: number, defaultWidth: number): number[] {
  const all = [defaultWidth, maxWidth, 640, 480, 320, 240];
  return [...new Set(all)].filter((w) => w >= 16 && w <= maxWidth).sort((a, b) => b - a);
}

/** The estimate as the panel words it: it is an upper-ish guess, not a promise. */
export function formatEstimate(bytes: number): string {
  return `up to about ${formatBytes(bytes)}`;
}

/** Suggested file name in local time, for example `Snipvero-2026-10-30-143000.gif`. */
export function gifFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `Snipvero-${day}-${time}.gif`;
}

/** The progress bar's value for a fraction, as a whole percent that never shows 100 before the end. */
export function percent(fraction: number): number {
  return Math.min(99, Math.max(0, Math.floor(fraction * 100)));
}
