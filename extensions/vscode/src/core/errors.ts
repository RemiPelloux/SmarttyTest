/**
 * Errors raised by the extension itself. The codes are stable for this extension
 * (`ST_EXT_*`) and never replace a `smarttest` error code: when the CLI reports an
 * error, the CLI code is preserved in `cliCode`.
 */
export type ExtensionErrorCategory =
  | "usage"
  | "configuration"
  | "infrastructure"
  | "contract"
  | "cancelled"
  | "policy"
  | "internal";

export interface ExtensionErrorOptions {
  readonly code: string;
  readonly category: ExtensionErrorCategory;
  readonly hint?: string;
  readonly cause?: unknown;
  /** Stable error code reported by the local smarttest executable, when there is one. */
  readonly cliCode?: string;
}

export class SmartTestExtensionError extends Error {
  readonly code: string;
  readonly category: ExtensionErrorCategory;
  readonly hint: string | undefined;
  readonly cliCode: string | undefined;

  constructor(message: string, options: ExtensionErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SmartTestExtensionError";
    this.code = options.code;
    this.category = options.category;
    this.hint = options.hint;
    this.cliCode = options.cliCode;
  }
}

export class CancelledError extends SmartTestExtensionError {
  constructor(message = "SmartTest analysis was cancelled") {
    super(message, { code: "ST_EXT_CANCELLED", category: "cancelled" });
  }
}

export function isCancelledError(error: unknown): boolean {
  if (error instanceof CancelledError) return true;
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "CancelledError";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorHint(error: unknown): string | undefined {
  return error instanceof SmartTestExtensionError ? error.hint : undefined;
}

export function errorCode(error: unknown): string {
  return error instanceof SmartTestExtensionError ? error.code : "ST_EXT_UNKNOWN";
}
