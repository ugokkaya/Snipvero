import { describe, expect, it, vi } from "vitest";
import { windowFitter } from "./fit";

/**
 * A window whose requested height includes `titleBar` points of chrome, as on macOS 27 (0 where
 * the request is the web view's height). Resizes apply when `apply` is called, like the native
 * resize that lands after the IPC answer, and then fire the window's resize event.
 */
function fakeWindow(content: { height: number }, titleBar: number, initial = 480) {
  let inner = initial - titleBar;
  const requests: number[] = [];
  const queue: number[] = [];
  const fit = windowFitter(
    () => ({ content: content.height, window: inner }),
    (height) => {
      requests.push(height);
      queue.push(height);
      return Promise.resolve();
    },
  );
  /** Applies every pending resize, running the fitter after each (the resize event). */
  async function settle() {
    await fit();
    for (let i = 0; i < 20 && queue.length > 0; i++) {
      inner = (queue.shift() ?? 0) - titleBar;
      await fit();
    }
  }
  return { fit, settle, requests, inner: () => inner };
}

describe("windowFitter", () => {
  it.each([0, 28])("fits the content exactly when the title bar adds %i pt", async (titleBar) => {
    const content = { height: 476.4 };
    const win = fakeWindow(content, titleBar);
    await win.settle();
    expect(win.inner()).toBe(477);
    // One request where sizes are the web view's, one correction where they include the title bar.
    expect(win.requests).toHaveLength(titleBar === 0 ? 1 : 2);
  });

  it.each([0, 28])("follows content that grows and shrinks (title bar %i pt)", async (titleBar) => {
    const content = { height: 450 };
    const win = fakeWindow(content, titleBar);
    await win.settle();
    content.height = 560; // permission guidance appears
    await win.settle();
    expect(win.inner()).toBe(560);
    content.height = 470;
    await win.settle();
    expect(win.inner()).toBe(470);
  });

  it("does nothing when the window already fits", async () => {
    const resize = vi.fn(() => Promise.resolve());
    await windowFitter(() => ({ content: 480, window: 480 }), resize)();
    expect(resize).not.toHaveBeenCalled();
  });

  it("never runs two resizes at once", async () => {
    const pending: (() => void)[] = [];
    const resize = vi.fn(() => new Promise<void>((finish) => pending.push(finish)));
    let content = 448;
    const fit = windowFitter(() => ({ content, window: 480 }), resize);
    const first = fit();
    content = 520; // the status rows appear while the first resize is in flight
    void fit();
    void fit();
    expect(resize).toHaveBeenCalledTimes(1);
    pending[0]?.();
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2));
    pending[1]?.();
    await first;
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("gives up instead of oscillating when the window never takes the size", async () => {
    const resize = vi.fn(() => Promise.resolve());
    const fit = windowFitter(() => ({ content: 500, window: 480 }), resize);
    for (let i = 0; i < 10; i++) await fit();
    expect(resize).toHaveBeenCalledTimes(4);
  });

  it("stops after a failed resize", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const resize = vi.fn(() => Promise.reject(new Error("denied")));
    await windowFitter(() => ({ content: 500, window: 480 }), resize)();
    expect(resize).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
