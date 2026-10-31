import { useEffect, type RefObject } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { windowFitter } from "./fit";

/**
 * Sizes the current window to the height of `ref`, so content appearing or going away (permission
 * guidance, status rows) neither scrolls nor leaves empty space. Needs `core:window:allow-set-size`.
 */
export function useFitWindow(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const fit = windowFitter(
      () => ({ content: element.getBoundingClientRect().height, window: window.innerHeight }),
      (height) => getCurrentWindow().setSize(new LogicalSize(window.innerWidth, height)),
    );
    const onChange = () => void fit();
    const observer = new ResizeObserver(onChange);
    observer.observe(element);
    // The native resize lands after the IPC answer; measure again once it has.
    window.addEventListener("resize", onChange);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onChange);
    };
  }, [ref]);
}
