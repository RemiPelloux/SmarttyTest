import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSettings, SETTING_BOUNDS, SETTING_DEFAULTS } from "../src/core/settings.js";

function reader(values: Record<string, unknown>) {
  return (key: string): unknown => values[key];
}

describe("settings", () => {
  it("returns the declared defaults", () => {
    expect(readSettings(() => undefined)).toEqual({ settings: SETTING_DEFAULTS, problems: [] });
  });

  it("reads nested CodeLens, hover and status bar keys", () => {
    const { settings, problems } = readSettings(
      reader({
        "codeLens.enabled": false,
        "hover.enabled": false,
        "statusBar.enabled": false,
      }),
    );
    expect(problems).toEqual([]);
    expect(settings.codeLensEnabled).toBe(false);
    expect(settings.hoverEnabled).toBe(false);
    expect(settings.statusBarEnabled).toBe(false);
  });

  it("reports invalid values instead of silently accepting them", () => {
    const { settings, problems } = readSettings(
      reader({
        mode: "yolo",
        changeSource: "everything",
        refreshDelayMs: 1.5,
        maxConcurrentExplain: 99,
        maxUnitsPerFile: 0,
        analysisTimeoutMs: "soon",
      }),
    );
    expect(settings.mode).toBe(SETTING_DEFAULTS.mode);
    expect(settings.changeSource).toBe(SETTING_DEFAULTS.changeSource);
    expect(settings.refreshDelayMs).toBe(SETTING_DEFAULTS.refreshDelayMs);
    expect(settings.maxConcurrentExplain).toBe(SETTING_DEFAULTS.maxConcurrentExplain);
    expect(settings.maxUnitsPerFile).toBe(SETTING_DEFAULTS.maxUnitsPerFile);
    expect(settings.analysisTimeoutMs).toBe(SETTING_DEFAULTS.analysisTimeoutMs);
    expect(problems).toHaveLength(6);
    expect(problems.join("\n")).toContain("`smarttest.mode`");
  });

  it("accepts the three safety modes", () => {
    for (const mode of ["fast", "balanced", "safe"] as const)
      expect(readSettings(reader({ mode })).settings.mode).toBe(mode);
  });

  it("trims paths but keeps whitespace-only values empty", () => {
    expect(
      readSettings(reader({ executablePath: "  /bin/smarttest " })).settings.executablePath,
    ).toBe("/bin/smarttest");
  });

  it("declares the same numeric bounds in package.json as it enforces", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      contributes: {
        configuration: { properties: Record<string, { minimum?: number; maximum?: number }> };
      };
    };
    const properties = manifest.contributes.configuration.properties;
    for (const [key, bounds] of Object.entries(SETTING_BOUNDS))
      expect([
        key,
        properties[`smarttest.${key}`]?.minimum,
        properties[`smarttest.${key}`]?.maximum,
      ]).toEqual([key, bounds.minimum, bounds.maximum]);
  });
});
