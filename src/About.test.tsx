// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { About, DESCRIPTION, DEVELOPER } from "./About";
import type { AppInfo } from "./ipc";

const ipc = vi.hoisted(() => ({
  appInfo: vi.fn(),
  openLink: vi.fn(),
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  cancelUpdate: vi.fn(),
  updateFailure: vi.fn(),
}));
const close = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./ipc", () => ipc);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close, setSize: vi.fn(() => Promise.resolve()) }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: AppInfo = {
  name: "Snipvero",
  version: "9.8.7-test.1",
  copyright: "© 2026 Snipvero Contributors",
  repository: "https://github.com/ugokkaya/Snipvero",
  contributors: "https://github.com/ugokkaya/Snipvero/graphs/contributors",
};

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  vi.clearAllMocks();
  ipc.appInfo.mockResolvedValue(INFO);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<About />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const text = () => container.textContent ?? "";

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("element missing");
  let notPrevented = true;
  await act(async () => {
    notPrevented = element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  return notPrevented;
}

describe("About window", () => {
  it("shows the app details, with the version and copyright from the metadata", () => {
    expect(container.querySelector("h1")?.textContent).toBe("Snipvero");
    expect(container.querySelector(".about-version")?.textContent).toBe("Version 9.8.7-test.1");
    expect(text()).toContain(
      "A lightweight, open-source screenshot and annotation application for macOS.",
    );
    expect(DESCRIPTION).toContain("open-source");
    expect(text()).toContain(DEVELOPER);
    expect(text()).toContain("MIT License");
    expect(container.querySelector(".about-copyright")?.textContent).toBe(
      "© 2026 Snipvero Contributors",
    );
  });

  it("shows no email address or other private contact details", () => {
    expect(text()).not.toMatch(/@/);
    expect(container.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  /** The value cell of the details row labelled `label`. */
  function row(label: string): HTMLElement {
    const term = [...container.querySelectorAll("dt")].find((dt) => dt.textContent === label);
    const value = term?.nextElementSibling;
    if (!(value instanceof HTMLElement)) throw new Error(`no row "${label}"`);
    return value;
  }

  it("lists developer, source code, contributors and license, in that order", () => {
    const labels = [...container.querySelectorAll("dt")].map((dt) => dt.textContent);
    expect(labels).toEqual(["Developer", "Source Code", "Contributors", "License"]);
    expect(row("Developer").textContent).toBe(DEVELOPER);
    expect(row("License").textContent).toContain("MIT License");
  });

  it.each([
    [
      "Source Code",
      "https://github.com/ugokkaya/Snipvero",
      "github.com/ugokkaya/Snipvero",
      "repository",
    ],
    [
      "Contributors",
      "https://github.com/ugokkaya/Snipvero/graphs/contributors",
      "View on GitHub",
      "contributors",
    ],
  ])("links %s to %s, opened in the browser by Rust", async (label, href, text, target) => {
    const link = row(label).querySelector("a");
    expect(link?.getAttribute("href")).toBe(href);
    expect(link?.textContent).toBe(text);
    // The web view must not navigate; Rust opens the default browser.
    expect(await click(link)).toBe(false);
    expect(ipc.openLink).toHaveBeenCalledExactlyOnceWith(target);
  });

  it("makes every link reachable from the keyboard", () => {
    const controls = [
      ...container.querySelectorAll<HTMLElement>(".about-details a, .about-details button"),
    ];
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect(control.tabIndex).toBeGreaterThanOrEqual(0);
      control.focus();
      expect(document.activeElement).toBe(control);
    }
  });

  it("opens the bundled license text", async () => {
    const view = [...container.querySelectorAll("button")].find((b) => b.textContent === "View");
    await click(view);
    expect(ipc.openLink).toHaveBeenCalledWith("license");
  });

  it("offers Check for Updates without contacting the network on its own", () => {
    const check = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Check for Updates…",
    );
    expect(check).toBeDefined();
    expect(ipc.checkForUpdate).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
