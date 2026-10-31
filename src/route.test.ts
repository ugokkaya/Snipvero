import { describe, expect, it } from "vitest";
import { routeFor } from "./route";

describe("routeFor", () => {
  it("shows the main window for its label", () => {
    expect(routeFor("main")).toEqual({ view: "main" });
  });

  it("shows the About page in the About window", () => {
    expect(routeFor("about")).toEqual({ view: "about" });
  });

  it("shows the overlay with its display index", () => {
    expect(routeFor("overlay-0")).toEqual({ view: "overlay", index: 0 });
    expect(routeFor("overlay-3")).toEqual({ view: "overlay", index: 3 });
  });

  it("never opens an overlay for a malformed label", () => {
    expect(routeFor("overlay-")).toEqual({ view: "main" });
    expect(routeFor("overlay-x")).toEqual({ view: "main" });
    expect(routeFor("overlay--1")).toEqual({ view: "main" });
  });
});
