import { useEffect, useState } from "react";
import { appInfo, type AppInfo } from "./ipc";

/** App metadata from Rust; `null` until it arrives, so nothing is shown that was not read. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let live = true;
    void appInfo().then((value) => {
      if (live) setInfo(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return info;
}
