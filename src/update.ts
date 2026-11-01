// Pure state of the About window's update section (ADR-028). Rust does the work; this only
// decides what the user sees and which action a button starts.
import type { UpdateCheck, UpdateFailure, UpdateProgress } from "./ipc";

export interface Release {
  current: string;
  version: string;
  notes: string;
}

export type UpdateView =
  | { step: "idle" }
  | { step: "checking" }
  | { step: "upToDate"; current: string }
  | ({ step: "available" } & Release)
  | ({ step: "downloading"; received: number; total: number | null } & Release)
  | { step: "installing"; version: string }
  | { step: "restarting"; version: string }
  /** `release` is kept when the update was found, so Try Again can return to it. */
  | { step: "failed"; failure: UpdateFailure; release: Release | null };

export type UpdateAction =
  | { type: "check" }
  | { type: "checked"; result: UpdateCheck }
  | { type: "dismiss" }
  | { type: "install" }
  | { type: "progress"; progress: UpdateProgress }
  | { type: "failed"; failure: UpdateFailure };

export const IDLE: UpdateView = { step: "idle" };

const releaseOf = (view: UpdateView): Release | null => {
  switch (view.step) {
    case "available":
    case "downloading":
      return { current: view.current, version: view.version, notes: view.notes };
    case "failed":
      return view.release;
    default:
      return null;
  }
};

export function reduce(view: UpdateView, action: UpdateAction): UpdateView {
  switch (action.type) {
    case "check":
      return { step: "checking" };
    case "checked": {
      const { current, available } = action.result;
      return available
        ? { step: "available", current, version: available.version, notes: available.notes }
        : { step: "upToDate", current };
    }
    case "dismiss":
      return IDLE;
    case "install": {
      // Only from an update the user is looking at; never started without one.
      const release = releaseOf(view);
      return release ? { step: "downloading", ...release, received: 0, total: null } : view;
    }
    case "progress": {
      const { progress } = action;
      if (progress.event === "installing" || progress.event === "restarting") {
        const version = releaseOf(view)?.version ?? ("version" in view ? view.version : "");
        return { step: progress.event, version };
      }
      if (view.step !== "downloading") return view;
      return progress.event === "started"
        ? { ...view, total: progress.data.contentLength }
        : { ...view, received: progress.data.bytes };
    }
    case "failed": {
      const release = releaseOf(view);
      // Cancelling a download is the user's choice, not an error: back to the offer.
      if (action.failure === "cancelled" && release) return { step: "available", ...release };
      return { step: "failed", failure: action.failure, release };
    }
  }
}

/** What Try Again does: install again after a capture was closed, otherwise check again. */
export const retryAction = (view: UpdateView): "install" | "check" | null => {
  if (view.step !== "failed" || view.failure === "unavailable") return null;
  return view.failure === "busy" && view.release ? "install" : "check";
};

export function failureMessage(failure: UpdateFailure): string {
  switch (failure) {
    case "unavailable":
      return "Updates are not available in this build.";
    case "network":
      return "Snipvero could not reach the update server. Check your internet connection and try again.";
    case "manifest":
      return "The update information could not be read.";
    case "noBuild":
      return "This update is not available for your Mac.";
    case "verification":
      return "The update could not be verified, so it was not installed.";
    case "location":
      return "Move Snipvero to the Applications folder, open it from there, and try again.";
    case "busy":
      return "Finish or cancel the current capture, then try again.";
    case "install":
      return "The update could not be installed.";
    case "cancelled":
      return "The download was cancelled.";
    case "inProgress":
      return "An update is already being downloaded in another Snipvero window.";
    case "failed":
      return "Something went wrong while updating.";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1)} MB`;
}
