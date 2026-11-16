import { describe, expect, it } from "vitest";
import { formatBytes, formatClock, recordingFileName } from "./format";

describe("formatClock", () => {
  it("shows minutes and seconds", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(59_999)).toBe("0:59");
    expect(formatClock(61_000)).toBe("1:01");
    expect(formatClock(600_000)).toBe("10:00");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("formatBytes", () => {
  it("uses decimal units with sensible precision", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1_500)).toBe("1.5 KB");
    expect(formatBytes(12_345_678)).toBe("12.3 MB");
    expect(formatBytes(123_456_789)).toBe("123 MB");
    expect(formatBytes(1_073_741_824)).toBe("1.1 GB");
  });
});

describe("recordingFileName", () => {
  it("uses local time and the mp4 extension, and is a valid plain file name", () => {
    const name = recordingFileName(new Date(2026, 9, 5, 4, 3, 2));
    expect(name).toBe("Snipvero-2026-10-05-040302.mp4");
    // The same rule Rust applies (`export::valid_file_name_with`).
    expect(name).toMatch(/^[A-Za-z0-9_.-]+\.mp4$/);
  });
});
