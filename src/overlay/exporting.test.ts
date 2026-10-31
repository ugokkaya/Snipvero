import { describe, expect, it, vi } from "vitest";
import type { Annotation, MeasureLine } from "./annotations";
import { clientToPixel, pixelToClient } from "./coords";
import {
  createExporter,
  exportFileName,
  layerPlan,
  type ExportDeps,
  type ExportRequest,
  type LayerPlan,
} from "./exporting";

const measure: MeasureLine = (line, size) => line.length * size * 0.5;
const REGION = { x: 100, y: 50, width: 400, height: 300 };
const ORIGIN = { x: 100, y: 50 };

const rect = (id: number, x: number, y: number, width = 50, height = 40): Annotation => ({
  kind: "rect",
  id,
  color: "#ff3b30",
  width: 4,
  rect: { x, y, width, height },
});

describe("layerPlan", () => {
  it("sends no layer without annotations", () => {
    expect(layerPlan([], REGION, ORIGIN, measure)).toBeNull();
  });

  it("is exactly the region's pixel size, aligned with the origin", () => {
    const plan = layerPlan([rect(1, 10, 10)], REGION, ORIGIN, measure);
    expect(plan).toMatchObject({ width: 400, height: 300, offset: { x: 0, y: 0 } });
  });

  it("keeps partly clipped annotations and leaves out those entirely outside", () => {
    const partly = rect(1, -30, 280); // crosses the left and bottom edges
    const outside = rect(2, 450, 10); // right of the 400 px region
    const plan = layerPlan([partly, outside], REGION, ORIGIN, measure);
    expect(plan?.annotations).toEqual([partly]);
    expect(layerPlan([outside], REGION, ORIGIN, measure)).toBeNull();
  });

  it("counts the stroke and antialiasing as inside", () => {
    // The rectangle ends 1 px left of the region, but its 4 px stroke reaches into it.
    expect(layerPlan([rect(1, -51, 10)], REGION, ORIGIN, measure)).not.toBeNull();
  });

  it("offsets annotations when the region and origin differ", () => {
    // Annotations are relative to the origin; the layer starts at the region.
    const plan = layerPlan([rect(1, 0, 0)], REGION, { x: 120, y: 40 }, measure);
    expect(plan?.offset).toEqual({ x: 20, y: -10 });
  });

  it("uses physical pixels on Retina and fractional displays", () => {
    // A 200×150 pt drag on a 2× display, and on a 1.5× display (2560 px over 1706.67 pt).
    const retina = { view: { width: 1512, height: 982 }, frame: { width: 3024, height: 1964 } };
    const a = clientToPixel({ x: 100, y: 50 }, retina.view, retina.frame);
    const b = clientToPixel({ x: 300, y: 200 }, retina.view, retina.frame);
    const region = { ...a, width: b.x - a.x, height: b.y - a.y };
    expect(layerPlan([rect(1, 0, 0)], region, a, measure)).toMatchObject({
      width: 400,
      height: 300,
    });
    const fractional = {
      view: { width: 2560 / 1.5, height: 960 },
      frame: { width: 2560, height: 1440 },
    };
    const c = clientToPixel({ x: 33.4, y: 10.2 }, fractional.view, fractional.frame);
    const d = clientToPixel({ x: 233.4, y: 110.2 }, fractional.view, fractional.frame);
    const plan = layerPlan(
      [rect(1, 0, 0)],
      { ...c, width: d.x - c.x, height: d.y - c.y },
      c,
      measure,
    );
    expect(plan && Number.isInteger(plan.width) && Number.isInteger(plan.height)).toBe(true);
    expect(plan).toMatchObject({ width: 300, height: 150 });
    // The preview places the same region at the same CSS position.
    const css = pixelToClient({ ...c, width: 300, height: 150 }, fractional.view, fractional.frame);
    expect(css.width).toBeCloseTo(200);
  });
});

describe("exportFileName", () => {
  it("uses local date and time with zero padding", () => {
    expect(exportFileName(new Date(2026, 9, 30, 14, 30, 0))).toBe("Snipvero-2026-10-30-143000.png");
    expect(exportFileName(new Date(2027, 0, 2, 3, 4, 5))).toBe("Snipvero-2027-01-02-030405.png");
  });
});

const request = (annotations: readonly Annotation[] = []): ExportRequest => ({
  session: 7,
  region: REGION,
  annotations,
  origin: ORIGIN,
  measure,
});

function deps(overrides: Partial<ExportDeps> = {}): ExportDeps {
  return {
    rasterize: vi.fn((plan: LayerPlan) =>
      Promise.resolve(new Uint8Array(plan.width * plan.height * 4)),
    ),
    copy: vi.fn(() => Promise.resolve("done" as const)),
    save: vi.fn(() => Promise.resolve("done" as const)),
    now: () => new Date(2026, 9, 30, 14, 30, 0),
    ...overrides,
  };
}

describe("createExporter", () => {
  it("copies a plain screenshot with an empty layer, without rasterizing", async () => {
    const d = deps();
    const result = await createExporter(d).run("copy", request());
    expect(result).toEqual({ status: "done" });
    expect(d.rasterize).not.toHaveBeenCalled();
    expect(d.copy).toHaveBeenCalledWith(7, REGION, new Uint8Array());
  });

  it("sends a region-sized layer with annotations", async () => {
    const d = deps();
    await createExporter(d).run("copy", request([rect(1, 10, 10)]));
    const layer = vi.mocked(d.copy).mock.calls[0]?.[2];
    expect(layer?.byteLength).toBe(400 * 300 * 4);
  });

  it("saves with the suggested file name", async () => {
    const d = deps();
    await createExporter(d).run("save", request());
    expect(d.save).toHaveBeenCalledWith(
      7,
      REGION,
      new Uint8Array(),
      "Snipvero-2026-10-30-143000.png",
    );
  });

  it("reports a cancelled save dialog so the overlay stays open", async () => {
    const d = deps({ save: vi.fn(() => Promise.resolve("cancelled" as const)) });
    const exporter = createExporter(d);
    expect(await exporter.run("save", request())).toEqual({ status: "cancelled" });
    expect(exporter.running).toBe(false);
    // The user can try again.
    expect(await exporter.run("save", request())).toEqual({ status: "cancelled" });
  });

  it("reports IPC and rasterization errors and allows a retry", async () => {
    const failing = deps({ save: vi.fn(() => Promise.reject("Could not save /x.png: denied")) });
    const exporter = createExporter(failing);
    expect(await exporter.run("save", request())).toEqual({
      status: "failed",
      message: "Could not save /x.png: denied",
    });
    expect(exporter.running).toBe(false);
    const canvas = deps({ rasterize: vi.fn(() => Promise.reject(new Error("no canvas"))) });
    expect(await createExporter(canvas).run("copy", request([rect(1, 0, 0)]))).toEqual({
      status: "failed",
      message: "no canvas",
    });
    expect(canvas.copy).not.toHaveBeenCalled();
  });

  it("ignores repeated requests while one is running", async () => {
    let finish: (value: "done") => void = () => undefined;
    const d = deps({ copy: vi.fn(() => new Promise<"done">((resolve) => (finish = resolve))) });
    const exporter = createExporter(d);
    const first = exporter.run("copy", request());
    expect(exporter.running).toBe(true);
    expect(await exporter.run("copy", request())).toEqual({ status: "busy" });
    expect(await exporter.run("save", request())).toEqual({ status: "busy" });
    finish("done");
    expect(await first).toEqual({ status: "done" });
    expect(d.copy).toHaveBeenCalledTimes(1);
    expect(d.save).not.toHaveBeenCalled();
  });
});
