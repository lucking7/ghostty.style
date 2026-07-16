import { describe, it, expect } from "vitest";
import {
  parseGhosttyConfig,
  cleanRawConfig,
  serializeGhosttyConfig,
} from "@/lib/config-parser";
import { DEFAULT_PALETTE } from "@/lib/constants";
import type { ParsedConfig } from "@/types/config";

// These are CHARACTERIZATION tests: they pin the CURRENT behavior of
// config-parser.ts. They are not a spec of desired behavior. If behavior
// changes intentionally, update these assertions to match.

describe("parseGhosttyConfig", () => {
  it("extracts fields from a minimal valid dark config (isDark true, no errors)", () => {
    const raw = [
      "background = #1e1e2e",
      "foreground = #cdd6f4",
      "palette = 0=#45475a",
      "palette = 1=#f38ba8",
    ].join("\n");

    const { config, errors } = parseGhosttyConfig(raw);

    expect(config.background).toBe("#1e1e2e");
    expect(config.foreground).toBe("#cdd6f4");
    expect(config.palette[0]).toBe("#45475a");
    expect(config.palette[1]).toBe("#f38ba8");
    expect(config.isDark).toBe(true);
    expect(errors).toEqual([]);
  });

  it("marks a light background as isDark false", () => {
    const { config } = parseGhosttyConfig("background = #ffffff");
    expect(config.isDark).toBe(false);
  });

  it("produces an error for an invalid hex background value", () => {
    const { config, errors } = parseGhosttyConfig("background = #zz0000");

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("background"))).toBe(true);
    // Invalid value is not stored; parser falls back to the default background.
    expect(config.background).toBe("#1e1e2e");
  });

  it("warns about an unknown key and references the key name", () => {
    const { warnings } = parseGhosttyConfig("no-such-key = 1");

    expect(
      warnings.some(
        (w) =>
          w.message.includes("no-such-key") &&
          w.message.includes("Unknown key"),
      ),
    ).toBe(true);
  });

  it("suggests the correct key for a known typo (bg-opacity)", () => {
    const { warnings } = parseGhosttyConfig("bg-opacity = 0.9");

    expect(
      warnings.some(
        (w) =>
          w.message.includes("bg-opacity") &&
          w.message.includes("background-opacity"),
      ),
    ).toBe(true);
  });

  it("populates typed fields for cursor-style, font-size, background-opacity", () => {
    const raw = [
      "cursor-style = bar",
      "font-size = 14",
      "background-opacity = 0.9",
    ].join("\n");

    const { config } = parseGhosttyConfig(raw);

    expect(config.cursorStyle).toBe("bar");
    expect(config.fontSize).toBe(14);
    expect(config.bgOpacity).toBe(0.9);
  });

  it("maps cursor-style block_hollow down to block", () => {
    const { config } = parseGhosttyConfig("cursor-style = block_hollow");
    expect(config.cursorStyle).toBe("block");
  });

  it("fills the palette with 16 default entries when no palette lines are given", () => {
    const { config } = parseGhosttyConfig("background = #1e1e2e");
    expect(config.palette).toHaveLength(16);
    expect(config.palette).toEqual(DEFAULT_PALETTE);
  });

  it("extracts theme", () => {
    const { config } = parseGhosttyConfig("theme = catppuccin-mocha");
    expect(config.theme).toBe("catppuccin-mocha");
  });

  it("detects an inline comment and warns", () => {
    const { config, warnings } = parseGhosttyConfig(
      "background = #0a0a0a  # dark bg",
    );
    expect(config.background).toBe("#0a0a0a");
    expect(warnings.some((w) => w.message.includes("Inline comment"))).toBe(
      true,
    );
  });
});

describe("cleanRawConfig", () => {
  it("removes whole-line comments", () => {
    const out = cleanRawConfig("# hello\nbackground = #0a0a0a");
    expect(out).not.toContain("# hello");
    expect(out).toContain("background = #0a0a0a");
  });

  it("strips an inline comment but keeps the value", () => {
    const out = cleanRawConfig("background = #0a0a0a  # dark bg");
    expect(out.trim()).toBe("background = #0a0a0a");
  });

  it("preserves hex color values (3-digit, 6-digit, and palette)", () => {
    const raw = [
      "cursor-color = #abc",
      "background = #0a0a0a",
      "palette = 0=#282c34",
    ].join("\n");

    const out = cleanRawConfig(raw);

    expect(out).toContain("cursor-color = #abc");
    expect(out).toContain("background = #0a0a0a");
    expect(out).toContain("palette = 0=#282c34");
  });

  it("is idempotent for all fixtures", () => {
    const fixtures = [
      "# hello\nbackground = #0a0a0a",
      "background = #0a0a0a  # dark bg",
      "cursor-color = #abc\nbackground = #0a0a0a\npalette = 0=#282c34",
      "theme = catppuccin-mocha\n\n\nfont-size = 14  # comment\n",
    ];

    for (const raw of fixtures) {
      const once = cleanRawConfig(raw);
      const twice = cleanRawConfig(once);
      expect(twice).toBe(once);
    }
  });
});

describe("serializeGhosttyConfig", () => {
  const fullyPopulated: ParsedConfig = {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursorColor: "#f5e0dc",
    cursorText: "#11111b",
    selectionBg: "#585b70",
    selectionFg: "#cdd6f4",
    palette: [...DEFAULT_PALETTE],
    fontFamily: "JetBrains Mono",
    fontSize: 14,
    cursorStyle: "bar",
    bgOpacity: 0.9,
    unfocusedSplitOpacity: 0.7,
    unfocusedSplitFill: "#313244",
    splitDividerColor: "#45475a",
    isDark: true,
    theme: "catppuccin-mocha",
  };

  it("round-trips a fully-populated config through serialize + parse", () => {
    const serialized = serializeGhosttyConfig(fullyPopulated);
    const { config } = parseGhosttyConfig(serialized);
    expect(config).toEqual(fullyPopulated);
  });

  it("omits optional fields that are null", () => {
    const minimal: ParsedConfig = {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursorColor: null,
      cursorText: null,
      selectionBg: null,
      selectionFg: null,
      palette: [...DEFAULT_PALETTE],
      fontFamily: null,
      fontSize: null,
      cursorStyle: null,
      bgOpacity: null,
      unfocusedSplitOpacity: null,
      unfocusedSplitFill: null,
      splitDividerColor: null,
      isDark: true,
      theme: null,
    };

    const out = serializeGhosttyConfig(minimal);

    expect(out).not.toContain("cursor-color");
    expect(out).not.toContain("cursor-text");
    expect(out).not.toContain("selection-background");
    expect(out).not.toContain("font-family");
    expect(out).not.toContain("font-size");
    expect(out).not.toContain("cursor-style");
    expect(out).not.toContain("background-opacity");
    expect(out).not.toContain("unfocused-split");
    expect(out).not.toContain("split-divider-color");
    expect(out).not.toContain("theme");
    expect(out).not.toContain("null");
  });

  it("emits exactly 16 palette lines for a 16-color palette", () => {
    const out = serializeGhosttyConfig(fullyPopulated);
    const paletteLines = out
      .split("\n")
      .filter((l) => l.startsWith("palette = "));
    expect(paletteLines).toHaveLength(16);
  });
});
