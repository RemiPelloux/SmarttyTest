/**
 * Settings validation, kept free of the VS Code API so it can be tested.
 * An invalid setting is reported as a problem. The declared default is used so
 * the extension still works, and the status bar tooltip names every problem.
 */
import type { SafetyMode } from "./contracts.js";

export type ChangeSource = "uncommitted" | "staged" | "base";

export interface ExtensionSettings {
  readonly executablePath: string;
  readonly mode: SafetyMode;
  readonly changeSource: ChangeSource;
  readonly baseRef: string;
  readonly refreshDelayMs: number;
  readonly codeLensEnabled: boolean;
  readonly hoverEnabled: boolean;
  readonly statusBarEnabled: boolean;
  readonly maxConcurrentExplain: number;
  readonly maxUnitsPerFile: number;
  readonly analysisTimeoutMs: number;
  readonly runTimeoutMs: number;
}

export const SETTING_DEFAULTS: ExtensionSettings = {
  executablePath: "",
  mode: "balanced",
  changeSource: "uncommitted",
  baseRef: "",
  refreshDelayMs: 350,
  codeLensEnabled: true,
  hoverEnabled: true,
  statusBarEnabled: true,
  maxConcurrentExplain: 2,
  maxUnitsPerFile: 150,
  analysisTimeoutMs: 120_000,
  runTimeoutMs: 900_000,
};

type Reader = (key: string) => unknown;

const CONFIG_KEYS: { readonly [K in keyof ExtensionSettings]: string } = {
  executablePath: "executablePath",
  mode: "mode",
  changeSource: "changeSource",
  baseRef: "baseRef",
  refreshDelayMs: "refreshDelayMs",
  codeLensEnabled: "codeLens.enabled",
  hoverEnabled: "hover.enabled",
  statusBarEnabled: "statusBar.enabled",
  maxConcurrentExplain: "maxConcurrentExplain",
  maxUnitsPerFile: "maxUnitsPerFile",
  analysisTimeoutMs: "analysisTimeoutMs",
  runTimeoutMs: "runTimeoutMs",
};

function stringSetting(
  read: Reader,
  key: keyof ExtensionSettings,
  problems: string[],
  maxLength = 4096,
): string {
  const value = read(CONFIG_KEYS[key]);
  const fallback = SETTING_DEFAULTS[key];
  if (value === undefined) return String(fallback);
  if (typeof value !== "string") {
    problems.push(`\`smarttest.${key}\` must be a string.`);
    return String(fallback);
  }
  if (value.length > maxLength) {
    problems.push(`\`smarttest.${key}\` is too long.`);
    return String(fallback);
  }
  return value.trim();
}

function booleanSetting(read: Reader, key: keyof ExtensionSettings, problems: string[]): boolean {
  const value = read(CONFIG_KEYS[key]);
  const fallback = SETTING_DEFAULTS[key] as boolean;
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    problems.push(`\`smarttest.${key}\` must be true or false.`);
    return fallback;
  }
  return value;
}

function integerSetting(
  read: Reader,
  key: keyof ExtensionSettings,
  minimum: number,
  maximum: number,
  problems: string[],
): number {
  const value = read(CONFIG_KEYS[key]);
  const fallback = SETTING_DEFAULTS[key] as number;
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    problems.push(`\`smarttest.${key}\` must be a whole number.`);
    return fallback;
  }
  if (value < minimum || value > maximum) {
    problems.push(`\`smarttest.${key}\` must be between ${minimum} and ${maximum}.`);
    return fallback;
  }
  return value;
}

export function readSettings(read: Reader): {
  readonly settings: ExtensionSettings;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];
  const mode = read(CONFIG_KEYS.mode);
  let resolvedMode: SafetyMode = SETTING_DEFAULTS.mode;
  if (mode !== undefined) {
    if (mode === "fast" || mode === "balanced" || mode === "safe") resolvedMode = mode;
    else problems.push('`smarttest.mode` must be "fast", "balanced" or "safe".');
  }
  const changeSource = read(CONFIG_KEYS.changeSource);
  let resolvedChangeSource: ChangeSource = SETTING_DEFAULTS.changeSource;
  if (changeSource !== undefined) {
    if (changeSource === "uncommitted" || changeSource === "staged" || changeSource === "base")
      resolvedChangeSource = changeSource;
    else problems.push('`smarttest.changeSource` must be "uncommitted", "staged" or "base".');
  }
  return {
    settings: {
      executablePath: stringSetting(read, "executablePath", problems),
      mode: resolvedMode,
      changeSource: resolvedChangeSource,
      baseRef: stringSetting(read, "baseRef", problems, 256),
      refreshDelayMs: integerSetting(read, "refreshDelayMs", 0, 60_000, problems),
      codeLensEnabled: booleanSetting(read, "codeLensEnabled", problems),
      hoverEnabled: booleanSetting(read, "hoverEnabled", problems),
      statusBarEnabled: booleanSetting(read, "statusBarEnabled", problems),
      maxConcurrentExplain: integerSetting(read, "maxConcurrentExplain", 1, 8, problems),
      maxUnitsPerFile: integerSetting(read, "maxUnitsPerFile", 1, 2_000, problems),
      analysisTimeoutMs: integerSetting(read, "analysisTimeoutMs", 1_000, 3_600_000, problems),
      runTimeoutMs: integerSetting(read, "runTimeoutMs", 1_000, 86_400_000, problems),
    },
    problems,
  };
}
