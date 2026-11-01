import { describe, expect, it } from "vitest";
import { UPDATE_FAILURES, updateFailure } from "./ipc";
import {
  IDLE,
  failureMessage,
  formatBytes,
  reduce,
  retryAction,
  type UpdateAction,
  type UpdateView,
} from "./update";

const run = (...actions: UpdateAction[]) => actions.reduce(reduce, IDLE);

const found: UpdateAction = {
  type: "checked",
  result: { current: "0.1.0-beta.3", available: { version: "0.1.0-beta.4", notes: "Fixes." } },
};
const release = { current: "0.1.0-beta.3", version: "0.1.0-beta.4", notes: "Fixes." };

describe("update view", () => {
  it("shows an offer only after a check found a newer version", () => {
    expect(run({ type: "check" })).toEqual({ step: "checking" });
    expect(run({ type: "check" }, found)).toEqual({ step: "available", ...release });
    expect(
      run(
        { type: "check" },
        { type: "checked", result: { current: "0.1.0-beta.3", available: null } },
      ),
    ).toEqual({ step: "upToDate", current: "0.1.0-beta.3" });
  });

  it("never starts an install without an offer on screen", () => {
    expect(run({ type: "install" })).toEqual(IDLE);
    expect(run({ type: "check" }, { type: "install" })).toEqual({ step: "checking" });
  });

  it("follows the download, installation and restart", () => {
    let view = run(found, { type: "install" });
    expect(view).toEqual({ step: "downloading", ...release, received: 0, total: null });
    view = reduce(view, {
      type: "progress",
      progress: { event: "started", data: { contentLength: 3_000_000 } },
    });
    view = reduce(view, {
      type: "progress",
      progress: { event: "downloaded", data: { bytes: 1_500_000 } },
    });
    expect(view).toMatchObject({ step: "downloading", received: 1_500_000, total: 3_000_000 });
    view = reduce(view, { type: "progress", progress: { event: "installing" } });
    expect(view).toEqual({ step: "installing", version: "0.1.0-beta.4" });
    view = reduce(view, { type: "progress", progress: { event: "restarting" } });
    expect(view).toEqual({ step: "restarting", version: "0.1.0-beta.4" });
  });

  it("returns to the offer when the download is cancelled", () => {
    const view = run(found, { type: "install" }, { type: "failed", failure: "cancelled" });
    expect(view).toEqual({ step: "available", ...release });
  });

  it("keeps the offer behind a failure, so Try Again can return to it", () => {
    const busy = run(found, { type: "install" }, { type: "failed", failure: "busy" });
    expect(busy).toEqual({ step: "failed", failure: "busy", release });
    expect(retryAction(busy)).toBe("install");
    expect(reduce(busy, { type: "install" })).toMatchObject({ step: "downloading", received: 0 });
  });

  it.each([
    ["network", "check"],
    ["verification", "check"],
    ["install", "check"],
    ["manifest", "check"],
    ["unavailable", null],
  ] as const)("offers %s → %s", (failure, expected) => {
    const view: UpdateView = run(found, { type: "install" }, { type: "failed", failure });
    expect(retryAction(view)).toBe(expected);
  });

  it("retries a busy failure without an offer as a check", () => {
    expect(retryAction(run({ type: "failed", failure: "busy" }))).toBe("check");
  });

  it("ignores stray progress outside a download", () => {
    expect(
      reduce(IDLE, { type: "progress", progress: { event: "downloaded", data: { bytes: 1 } } }),
    ).toEqual(IDLE);
  });
});

describe("failures", () => {
  it("has a message for every reason Rust can give", () => {
    for (const failure of UPDATE_FAILURES) {
      expect(failureMessage(failure).length).toBeGreaterThan(10);
    }
  });

  it("treats unknown rejections as a generic failure", () => {
    expect(updateFailure("verification")).toBe("verification");
    expect(updateFailure("something else")).toBe("failed");
    expect(updateFailure(new Error("network"))).toBe("failed");
    expect(updateFailure(undefined)).toBe("failed");
  });
});

it("formats download sizes", () => {
  expect(formatBytes(0)).toBe("0 KB");
  expect(formatBytes(420_000)).toBe("420 KB");
  expect(formatBytes(2_670_768)).toBe("2.7 MB");
});
