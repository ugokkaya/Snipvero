import { afterEach, describe, expect, it } from "vitest";
import { en, format, languageFromTag, setLanguage, t, tr, type MessageKey } from "./i18n";

const names = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => setLanguage("en"));

describe("catalogues", () => {
  const keys = Object.keys(en) as MessageKey[];

  it("have a Turkish message for every English one, and none left over", () => {
    expect(Object.keys(tr).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(tr[key].trim(), key).not.toBe("");
  });

  it("use the same parameters in both languages", () => {
    for (const key of keys) expect(names(tr[key]), key).toEqual(names(en[key]));
  });
});

describe("t", () => {
  it("is English until told otherwise", () => {
    expect(t("app.language.title")).toBe("Language");
  });

  it("follows setLanguage", () => {
    setLanguage("tr");
    expect(t("app.language.title")).toBe("Dil");
  });
});

describe("format", () => {
  it("fills named parameters and leaves unknown ones", () => {
    expect(format("{a} of {b}", { a: 1, b: "x" })).toBe("1 of x");
    expect(format("{a} {c}", { a: 1 })).toBe("1 {c}");
    expect(format("plain")).toBe("plain");
  });
});

describe("languageFromTag", () => {
  it("is Turkish only for Turkish tags", () => {
    expect(languageFromTag("tr")).toBe("tr");
    expect(languageFromTag("tr-TR")).toBe("tr");
    expect(languageFromTag("TR-tr")).toBe("tr");
    expect(languageFromTag("en-TR")).toBe("en");
    expect(languageFromTag("trx")).toBe("en");
  });
});
