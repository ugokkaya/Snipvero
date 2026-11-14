// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FrameInfo } from "../ipc";

const ipc = vi.hoisted(() => ({
  frameInfo: vi.fn(),
  onOverlayLoad: vi.fn(),
  onSelectionCleared: vi.fn(() => Promise.resolve(() => undefined)),
  overlayCancel: vi.fn(() => Promise.resolve(true)),
  overlayCaptureDelayed: vi.fn(),
  overlayCopy: vi.fn(),
  overlayReady: vi.fn(() => Promise.resolve()),
  overlaySave: vi.fn(),
  overlaySelect: vi.fn(() => Promise.resolve()),
}));
vi.mock("../ipc", () => ipc);
vi.mock("../frame", () => ({ loadFrame: vi.fn(() => Promise.resolve({ close: vi.fn() })) }));
vi.mock("./AnnotationLayer", () => ({ AnnotationLayer: () => null }));
vi.mock("./rasterize", () => ({ rasterize: vi.fn() }));
import { Overlay } from "./Overlay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REGION = { x: 100, y: 200, width: 300, height: 400 };
const INFO: FrameInfo = {
  session: 1,
  index: 0,
  displayId: 10,
  bounds: { x: 0, y: 0, width: 1000, height: 800 },
  width: 2000,
  height: 1600,
  scale: 2,
  focused: true,
  region: REGION,
};
let root: Root;
let container: HTMLDivElement;
let reload: (session: number) => void;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  ipc.frameInfo.mockResolvedValue(INFO);
  ipc.overlayCaptureDelayed.mockResolvedValue(undefined);
  ipc.onOverlayLoad.mockImplementation((handler: (session: number) => void) => {
    reload = handler;
    return Promise.resolve(() => undefined);
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
});

function timer() {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label*="5 seconds"]');
  if (!button) throw new Error("missing timer button");
  return button;
}

it("requests native delayed capture only once, then reloads the same region with the new session", async () => {
  await act(async () => root.render(<Overlay index={0} />));
  expect(ipc.overlayReady).toHaveBeenCalledWith(1);
  await act(async () => {
    timer().click();
    timer().click();
  });
  expect(ipc.overlayCaptureDelayed).toHaveBeenCalledExactlyOnceWith(1, REGION);
  expect(timer().disabled).toBe(true);
  expect(ipc.overlayCopy).not.toHaveBeenCalled();
  expect(ipc.overlaySave).not.toHaveBeenCalled();
  ipc.frameInfo.mockResolvedValue({ ...INFO, session: 2 });
  await act(async () => reload(2));
  expect(ipc.overlayReady).toHaveBeenLastCalledWith(2);
  expect(ipc.overlaySelect).toHaveBeenLastCalledWith(2, REGION);
  expect(timer().disabled).toBe(false);
  await act(async () => timer().click());
  expect(ipc.overlayCaptureDelayed).toHaveBeenLastCalledWith(2, REGION);
});

it("shows a rejected request and permits another attempt", async () => {
  await act(async () => root.render(<Overlay index={0} />));
  ipc.overlayCaptureDelayed.mockRejectedValueOnce("capture not ready");
  await act(async () => timer().click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("capture not ready");
  expect(timer().disabled).toBe(false);
  await act(async () => timer().click());
  expect(ipc.overlayCaptureDelayed).toHaveBeenCalledTimes(2);
});
