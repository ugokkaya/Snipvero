/** Corrections allowed for one content height before giving up, so a window can never oscillate. */
const MAX_ATTEMPTS = 4;

/**
 * Keeps a window exactly as tall as its content. Two things make a single resize unreliable:
 * - Resize requests are IPC calls Tauri may run concurrently; two in flight could land in either
 *   order and leave a stale height. Requests therefore run one at a time, each measuring again.
 * - The requested size is not always the web view's height: on macOS 27 the title bar is included
 *   (measured: 412 pt requested, 413 pt frame, about 28 pt short). So the first request asks for
 *   the content height and later ones correct the last request by what is still missing; the
 *   caller runs the fitter again when the window has resized.
 */
export function windowFitter(
  measure: () => { content: number; window: number },
  resize: (height: number) => Promise<unknown>,
): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  let requested: number | null = null;
  let target = 0;
  let attempts = 0;

  const step = async () => {
    const { content, window } = measure();
    const height = Math.ceil(content);
    const missing = height - window;
    if (height <= 0 || missing === 0) return;
    if (height !== target) {
      target = height;
      attempts = 0;
    }
    if (attempts >= MAX_ATTEMPTS) return;
    attempts += 1;
    requested = requested === null ? height : requested + missing;
    await resize(requested);
  };

  const run = async () => {
    do {
      again = false;
      try {
        await step();
      } catch (error) {
        console.error("[window] could not resize", error);
        return;
      }
    } while (again);
  };

  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
    });
    return running;
  };
}
