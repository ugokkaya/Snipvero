import { describe, expect, it } from "vitest";
import css from "./App.css?raw";

/** Custom properties declared in the first block that starts at `start`. */
function tokens(start: string): Map<string, string> {
  const from = css.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", from) + 1);
  const declarations = body.slice(0, body.indexOf("}"));
  return new Map(
    [...declarations.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}

describe("theme", () => {
  const light = tokens(":root {");
  const dark = tokens("@media (prefers-color-scheme: dark)");

  it("follows the system appearance", () => {
    expect(css).toMatch(/color-scheme:\s*light dark/);
  });

  it("defines every colour token for both appearances", () => {
    expect(light.size).toBeGreaterThan(10);
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
  });

  it("changes the surfaces and text between appearances", () => {
    for (const token of ["--bg", "--surface", "--text", "--text-secondary", "--link"]) {
      expect(dark.get(token), token).not.toBe(light.get(token));
    }
  });

  it("uses the indigo brand accent", () => {
    expect(light.get("--accent")).toBe("#4f46e5");
    expect(dark.get("--accent")).toBe("#6366f1");
  });

  it("styles the main window and About window only through tokens", () => {
    const main = css.slice(css.indexOf("/* Main window */"), css.indexOf("/* Capture overlay"));
    // Literal colours there would ignore the appearance; shadows and white-on-accent are exempt.
    const literals = [...main.matchAll(/^\s*(?:color|background|border-color):\s*(#[\da-f]+)/gim)];
    expect(literals).toEqual([]);
  });
});
