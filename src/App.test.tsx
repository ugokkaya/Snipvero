// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppInfo, AppStatus } from "./ipc";

const ipc = vi.hoisted(() => ({
  appInfo: vi.fn(),
  appStatus: vi.fn(),
  startCapture: vi.fn(),
  showAbout: vi.fn(),
  openLink: vi.fn(),
  openScreenRecordingSettings: vi.fn(),
  restartApp: vi.fn(),
  onCaptureFailed: vi.fn(),
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  cancelUpdate: vi.fn(),
  updateFailure: vi.fn(),
  onUpdateCheckRequested: vi.fn(() => Promise.resolve(() => undefined)),
  setShortcut: vi.fn(),
  suspendShortcut: vi.fn(),
  shortcutRejection: (error: unknown) => error,
}));
vi.mock("./ipc", () => ipc);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setSize: vi.fn(() => Promise.resolve()) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: AppInfo = {
  name: "Snipvero",
  // Not the real version: the page must show whatever the metadata says.
  version: "9.8.7-test.1",
  copyright: "© 2026 Snipvero Contributors",
  website: "https://snipvero.app",
  supportEmail: "support@snipvero.app",
  repository: "https://github.com/ugokkaya/Snipvero",
  contributors: "https://github.com/ugokkaya/Snipvero/graphs/contributors",
};

const status = (overrides: Partial<AppStatus> = {}): AppStatus => ({
  captureSupported: true,
  screenRecordingAllowed: true,
  shortcut: { accelerator: "CommandOrControl+Shift+2", registered: true, error: null },
  ...overrides,
});

let App: () => ReactElement;
let root: Root;
let container: HTMLElement;
let captureFailed: ((message: string) => void) | undefined;

beforeAll(async () => {
  // The platform is read once when the module loads.
  Object.defineProperty(navigator, "userAgent", {
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    configurable: true,
  });
  ({ App } = await import("./App"));
});

beforeEach(() => {
  vi.clearAllMocks();
  ipc.appInfo.mockResolvedValue(INFO);
  ipc.appStatus.mockResolvedValue(status());
  ipc.suspendShortcut.mockResolvedValue(status().shortcut);
  ipc.onCaptureFailed.mockImplementation((handler: (message: string) => void) => {
    captureFailed = handler;
    return Promise.resolve(() => {});
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
}

const text = () => container.textContent ?? "";

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

async function click(element: Element) {
  let notPrevented = true;
  await act(async () => {
    notPrevented = element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  return notPrevented;
}

describe("main window", () => {
  it("shows the name, subtitle and the version from the app metadata", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Snipvero");
    expect(text()).toContain("Screen capture & annotation");
    expect(container.querySelector(".badge")?.textContent).toBe("v9.8.7-test.1");
    expect(container.querySelector(".footer-version")?.textContent).toBe("Version 9.8.7-test.1");
    expect(text()).not.toContain("0.1.0");
  });

  it("starts the existing capture from the Capture Region button", async () => {
    await render();
    const capture = button("Capture Region");
    expect(capture.querySelector("kbd")?.textContent).toBe("⌘⇧2");
    await click(capture);
    expect(ipc.startCapture).toHaveBeenCalledTimes(1);
  });

  it("shows three feature cards", async () => {
    await render();
    const titles = [...container.querySelectorAll(".feature h2")].map((h) => h.textContent);
    expect(titles).toEqual(["Capture", "Annotate", "Export"]);
  });

  it("claims nothing about permission before the status arrives", async () => {
    ipc.appStatus.mockReturnValue(new Promise(() => {}));
    await render();
    expect(text()).toContain("Checking…");
    expect(text()).not.toContain("Allowed");
    expect(button("Capture Region").querySelector("kbd")).toBeNull();
  });

  it("reports granted Screen Recording permission without guidance", async () => {
    await render();
    expect(text()).toContain("Allowed");
    expect(text()).not.toContain("Open System Settings");
  });

  it("offers System Settings and a restart when permission is missing", async () => {
    ipc.appStatus.mockResolvedValue(status({ screenRecordingAllowed: false }));
    await render();
    expect(text()).toContain("Not allowed");
    await click(button("Open System Settings"));
    expect(ipc.openScreenRecordingSettings).toHaveBeenCalledTimes(1);
    await click(button("Restart Snipvero"));
    expect(ipc.restartApp).toHaveBeenCalledTimes(1);
  });

  it("explains an unavailable shortcut and leaves it off the button", async () => {
    ipc.appStatus.mockResolvedValue(
      status({
        shortcut: { accelerator: "CommandOrControl+Shift+2", registered: false, error: "in use" },
      }),
    );
    await render();
    expect(text()).toContain("Unavailable");
    expect(text()).toContain("could not be registered");
    expect(text()).toContain("Choose another shortcut");
    expect(button("Capture Region").querySelector("kbd")).toBeNull();
  });

  describe("changing the shortcut", () => {
    const key = (code: string, mods: KeyboardEventInit = {}) =>
      act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { code, cancelable: true, ...mods }));
      });

    it("releases the shortcut while recording and saves the new one", async () => {
      const changed = { accelerator: "CommandOrControl+Alt+S", registered: true, error: null };
      ipc.setShortcut.mockResolvedValue(changed);
      await render();
      await click(button("Change…"));
      expect(ipc.suspendShortcut).toHaveBeenCalledWith(true);
      expect(text()).toContain("Press the new shortcut");

      await key("MetaLeft", { metaKey: true });
      expect(ipc.setShortcut).not.toHaveBeenCalled();
      await key("KeyS", { metaKey: true, altKey: true });
      expect(ipc.setShortcut).toHaveBeenCalledWith("CommandOrControl+Alt+S");
      expect(text()).not.toContain("Press the new shortcut");
      expect(button("Capture Region").querySelector("kbd")?.textContent).toBe("⌘⌥S");
      expect(text()).toContain("Reset to ⌘⇧2");
    });

    it("explains a rejected shortcut and keeps recording", async () => {
      ipc.setShortcut.mockRejectedValue("modifiers");
      await render();
      await click(button("Change…"));
      await key("KeyC", { metaKey: true });
      expect(container.querySelector(".shortcut-error")?.textContent).toContain(
        "two modifier keys",
      );
      expect(text()).toContain("Press the new shortcut");
      expect(button("Capture Region").querySelector("kbd")?.textContent).toBe("⌘⇧2");
    });

    it("cancels with Escape and registers the shortcut again", async () => {
      await render();
      await click(button("Change…"));
      await key("Escape");
      expect(ipc.setShortcut).not.toHaveBeenCalled();
      expect(ipc.suspendShortcut).toHaveBeenLastCalledWith(false);
      expect(text()).not.toContain("Press the new shortcut");
    });

    it("stops recording when the window loses focus", async () => {
      await render();
      await click(button("Change…"));
      await act(async () => window.dispatchEvent(new Event("blur")));
      expect(ipc.suspendShortcut).toHaveBeenLastCalledWith(false);
      expect(text()).not.toContain("Press the new shortcut");
    });

    it("resets a custom shortcut to the default", async () => {
      ipc.appStatus.mockResolvedValue(
        status({
          shortcut: { accelerator: "CommandOrControl+Alt+S", registered: true, error: null },
        }),
      );
      ipc.setShortcut.mockResolvedValue(status().shortcut);
      await render();
      await click(button("Reset to ⌘⇧2"));
      expect(ipc.setShortcut).toHaveBeenCalledWith(null);
      expect(text()).not.toContain("Reset to");
    });
  });

  it("disables capture where the platform has no capture backend", async () => {
    ipc.appStatus.mockResolvedValue(status({ captureSupported: false }));
    await render();
    expect(button("Capture Region").disabled).toBe(true);
    expect(text()).toContain("not available on this platform");
  });

  it("shows a capture failure reported by Rust", async () => {
    await render();
    await act(async () => captureFailed?.("Screen capture failed: test"));
    expect(container.querySelector(".banner")?.textContent).toBe("Screen capture failed: test");
  });

  it("opens the About window", async () => {
    await render();
    await click(button("About Snipvero"));
    expect(ipc.showAbout).toHaveBeenCalledTimes(1);
  });

  it("links to the GitHub repository through Rust, without navigating", async () => {
    await render();
    const link = container.querySelector<HTMLAnchorElement>(`a[href="${INFO.repository}"]`);
    expect(link?.getAttribute("href")).toBe("https://github.com/ugokkaya/Snipvero");
    expect(link?.textContent).toBe("GitHub");
    link?.focus();
    expect(document.activeElement).toBe(link);
    expect(await click(link as Element)).toBe(false);
    expect(ipc.openLink).toHaveBeenCalledWith("repository");
  });

  it("opens the website through Rust without navigating", async () => {
    await render();
    const link = container.querySelector<HTMLAnchorElement>(`a[href="${INFO.website}"]`);
    expect(link?.textContent).toBe("snipvero.app");
    expect(await click(link as Element)).toBe(false);
    expect(ipc.openLink).toHaveBeenCalledWith("website");
  });
});
