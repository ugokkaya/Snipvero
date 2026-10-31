// Export decisions that need no canvas: what to rasterize, at which size, and the file name.
// The pixels themselves are composed in Rust (src-tauri/src/export), from the frame it holds.

import type { ExportOutcome } from "../ipc";
import { annotationBounds, type Annotation, type MeasureLine } from "./annotations";
import type { Point, Rect, Size } from "./coords";

/** The annotation layer sent with an export: exactly the region's size, in frame pixels. */
export interface LayerPlan extends Size {
  /** Where annotation coordinates (relative to `origin`) start inside the region. */
  offset: Point;
  annotations: readonly Annotation[];
}

/** Antialiasing and glyph overhang beyond the measured bounds, in frame pixels. */
const OVERHANG = 2;

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * The layer for `region`, or null when no annotation reaches into it, so a plain screenshot sends
 * no layer at all. Annotations partly outside are kept: the layer's edges clip them, as the
 * on-screen stage does. Annotations entirely outside are hidden there and left out here.
 */
export function layerPlan(
  annotations: readonly Annotation[],
  region: Rect,
  origin: Point,
  measure: MeasureLine,
): LayerPlan | null {
  const offset = { x: origin.x - region.x, y: origin.y - region.y };
  const area = { x: -offset.x, y: -offset.y, width: region.width, height: region.height };
  const visible = annotations.filter((a) => {
    const b = annotationBounds(a, measure);
    const grown = {
      x: b.x - OVERHANG,
      y: b.y - OVERHANG,
      width: b.width + 2 * OVERHANG,
      height: b.height + 2 * OVERHANG,
    };
    return overlaps(grown, area);
  });
  if (visible.length === 0 || region.width <= 0 || region.height <= 0) return null;
  return { width: region.width, height: region.height, offset, annotations: visible };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Suggested file name in local time, for example `Snipvero-2026-10-30-143000.png`. */
export function exportFileName(date: Date): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `Snipvero-${day}-${time}.png`;
}

export type ExportAction = "copy" | "save";

export interface ExportRequest {
  session: number;
  /** The selected region in frame pixels. */
  region: Rect;
  /** Committed annotations, relative to `origin`. */
  annotations: readonly Annotation[];
  origin: Point;
  measure: MeasureLine;
}

/** IPC and canvas access, injected so the flow is tested without a webview. */
export interface ExportDeps {
  rasterize: (plan: LayerPlan) => Promise<Uint8Array>;
  copy: (session: number, region: Rect, layer: Uint8Array) => Promise<ExportOutcome>;
  save: (
    session: number,
    region: Rect,
    layer: Uint8Array,
    fileName: string,
  ) => Promise<ExportOutcome>;
  now: () => Date;
}

export type ExportResult =
  | { status: ExportOutcome }
  /** Another export of this overlay is still running; nothing was sent. */
  | { status: "busy" }
  | { status: "failed"; message: string };

const errorMessage = (error: unknown) =>
  typeof error === "string" ? error : error instanceof Error ? error.message : "Export failed.";

/**
 * One overlay's export flow. At most one request runs at a time (Rust rejects a second one too).
 * After `done` Rust has closed the overlays; after `cancelled` or `failed` the overlay stays open
 * and the user may try again.
 */
export function createExporter(deps: ExportDeps) {
  let running = false;
  return {
    get running() {
      return running;
    },
    async run(action: ExportAction, request: ExportRequest): Promise<ExportResult> {
      if (running) return { status: "busy" };
      running = true;
      try {
        const { session, region, annotations, origin, measure } = request;
        const plan = layerPlan(annotations, region, origin, measure);
        const layer = plan ? await deps.rasterize(plan) : new Uint8Array();
        const status =
          action === "copy"
            ? await deps.copy(session, region, layer)
            : await deps.save(session, region, layer, exportFileName(deps.now()));
        return { status };
      } catch (error) {
        return { status: "failed", message: errorMessage(error) };
      } finally {
        running = false;
      }
    },
  };
}
