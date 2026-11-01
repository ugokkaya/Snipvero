// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheck, UpdateProgress } from "./ipc";
import { PRIVACY_NOTE, RESTART_NOTE, Updates, UpdatesRow } from "./Updates";

const ipc = vi.hoisted(() => ({
  checkForUpdate: vi.fn<() => Promise<UpdateCheck>>(),
  installUpdate: vi.fn<(onProgress: (progress: UpdateProgress) => void) => Promise<unknown>>(),
  cancelUpdate: vi.fn(() => Promise.resolve()),
  onUpdateCheckRequested: vi.fn<(handler: () => void) => Promise<() => void>>(),
}));
vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  ...ipc,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AVAILABLE: UpdateCheck = {
  current: "0.1.0-beta.3",
  available: { version: "0.1.0-beta.4", notes: "Fixes.\n<b>not markup</b>" },
};

let root: Root;
let container: HTMLElement;

beforeEach(async () => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Updates current="0.1.0-beta.3" />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === label);

async function click(label: string) {
  const element = button(label);
  if (!element) throw new Error(`no button "${label}" in: ${text()}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function offer() {
  ipc.checkForUpdate.mockResolvedValue(AVAILABLE);
  await click("Check for Updates…");
}

describe("Check for Updates", () => {
  it("makes no request until the user clicks, and says what a check sends", () => {
    expect(ipc.checkForUpdate).not.toHaveBeenCalled();
    expect(ipc.installUpdate).not.toHaveBeenCalled();
    expect(text()).toContain(PRIVACY_NOTE);
  });

  it("reports an up-to-date version", async () => {
    ipc.checkForUpdate.mockResolvedValue({ current: "0.1.0-beta.3", available: null });
    await click("Check for Updates…");
    expect(text()).toContain("Snipvero 0.1.0-beta.3 is up to date.");
    expect(button("Check Again")).toBeDefined();
  });

  it("shows the new version, the notes as plain text and the restart warning", async () => {
    await offer();
    expect(text()).toContain("Snipvero 0.1.0-beta.4 is available.");
    expect(text()).toContain("You have 0.1.0-beta.3.");
    const notes = container.querySelector(".update-notes");
    expect(notes?.textContent).toBe("Fixes.\n<b>not markup</b>");
    expect(notes?.querySelector("b")).toBeNull();
    expect(text()).toContain(RESTART_NOTE);
    // Finding an update installs nothing by itself.
    expect(ipc.installUpdate).not.toHaveBeenCalled();
  });

  it("goes back without installing on Not Now", async () => {
    await offer();
    await click("Not Now");
    expect(button("Check for Updates…")).toBeDefined();
    expect(ipc.installUpdate).not.toHaveBeenCalled();
  });

  it("downloads only after Download and Restart, showing progress and allowing Cancel", async () => {
    await offer();
    let report: (progress: UpdateProgress) => void = () => undefined;
    ipc.installUpdate.mockImplementation((onProgress) => {
      report = onProgress;
      return new Promise(() => undefined);
    });
    await click("Download and Restart");
    expect(ipc.installUpdate).toHaveBeenCalledTimes(1);
    await act(async () => {
      report({ event: "started", data: { contentLength: 3_000_000 } });
      report({ event: "downloaded", data: { bytes: 1_200_000 } });
    });
    const progress = container.querySelector("progress");
    expect(progress?.getAttribute("max")).toBe("3000000");
    expect(text()).toContain("1.2 MB of 3.0 MB");
    await click("Cancel");
    expect(ipc.cancelUpdate).toHaveBeenCalledTimes(1);

    await act(async () => report({ event: "installing" }));
    expect(text()).toContain("Installing Snipvero 0.1.0-beta.4");
    expect(button("Cancel")).toBeUndefined();
  });

  it("returns to the offer after a cancelled download", async () => {
    await offer();
    ipc.installUpdate.mockRejectedValue("cancelled");
    await click("Download and Restart");
    expect(button("Download and Restart")).toBeDefined();
  });

  it("refuses to install during a capture and retries the install", async () => {
    await offer();
    ipc.installUpdate.mockRejectedValueOnce("busy");
    await click("Download and Restart");
    expect(text()).toContain("Finish or cancel the current capture, then try again.");
    expect(text()).toContain("Snipvero 0.1.0-beta.3 keeps working.");
    ipc.installUpdate.mockReturnValue(new Promise(() => undefined));
    await click("Try Again");
    expect(ipc.installUpdate).toHaveBeenCalledTimes(2);
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["network", "could not reach the update server"],
    ["verification", "could not be verified, so it was not installed"],
    ["install", "could not be installed"],
    ["noBuild", "not available for your Mac"],
    ["location", "Move Snipvero to the Applications folder"],
  ])("explains a %s failure and checks again on Try Again", async (failure, message) => {
    await offer();
    ipc.installUpdate.mockRejectedValue(failure);
    await click("Download and Restart");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(text()).toContain("Snipvero 0.1.0-beta.3 keeps working.");
    ipc.checkForUpdate.mockResolvedValue({ current: "0.1.0-beta.3", available: null });
    await click("Try Again");
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("says when a build cannot update, without a retry", async () => {
    ipc.checkForUpdate.mockRejectedValue("unavailable");
    await click("Check for Updates…");
    expect(text()).toContain("Updates are not available in this build.");
    expect(button("Try Again")).toBeUndefined();
  });
});

describe("Updates row in the main window", () => {
  let requestCheck: () => void = () => undefined;

  beforeEach(async () => {
    ipc.onUpdateCheckRequested.mockImplementation((handler) => {
      requestCheck = handler;
      return Promise.resolve(() => undefined);
    });
    await act(async () => root.render(<UpdatesRow current="0.1.0-beta.3" />));
  });

  it("offers the check next to its title and requests nothing on its own", () => {
    expect(container.querySelector(".status-line button")?.textContent).toBe("Check for Updates…");
    expect(text()).toContain(PRIVACY_NOTE);
    expect(ipc.checkForUpdate).not.toHaveBeenCalled();
  });

  it("shows the offer under the title and installs only after consent", async () => {
    await offer();
    expect(text()).toContain("Snipvero 0.1.0-beta.4 is available.");
    expect(container.querySelector(".update-notes")?.textContent).toContain("Fixes.");
    expect(ipc.installUpdate).not.toHaveBeenCalled();
    ipc.installUpdate.mockReturnValue(new Promise(() => undefined));
    await click("Download and Restart");
    expect(ipc.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("puts Check Again next to the title after an up-to-date result", async () => {
    ipc.checkForUpdate.mockResolvedValue({ current: "0.1.0-beta.3", available: null });
    await click("Check for Updates…");
    expect(text()).toContain("Snipvero 0.1.0-beta.3 is up to date.");
    expect(container.querySelector(".status-line button")?.textContent).toBe("Check Again");
  });

  it("starts a check when the menu bar item asks for one", async () => {
    ipc.checkForUpdate.mockResolvedValue({ current: "0.1.0-beta.3", available: null });
    await act(async () => requestCheck());
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(text()).toContain("is up to date.");
  });

  it("does not restart a running download from the menu bar item", async () => {
    await offer();
    ipc.installUpdate.mockReturnValue(new Promise(() => undefined));
    await click("Download and Restart");
    await act(async () => requestCheck());
    expect(ipc.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(container.querySelector("progress")).not.toBeNull();
  });

  it("explains an install already running in the other window", async () => {
    await offer();
    ipc.installUpdate.mockRejectedValue("inProgress");
    await click("Download and Restart");
    expect(text()).toContain("already being downloaded in another Snipvero window");
  });
});
