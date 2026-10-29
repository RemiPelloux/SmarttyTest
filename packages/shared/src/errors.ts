/**
 * Stable error categories and exit codes (spec §26.6).
 * The numeric mapping is part of the public, versioned CLI contract:
 * changing a value is a breaking change.
 */
export const ExitCode = {
  Success: 0,
  TestFailure: 1,
  InvalidUsage: 2,
  ConfigurationFailure: 3,
  InfrastructureFailure: 4,
  PolicyFailure: 5,
  Internal: 70,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCategory =
  | "usage"
  | "configuration"
  | "infrastructure"
  | "policy"
  | "test-failure"
  | "internal";

const exitCodeByCategory: Record<ErrorCategory, ExitCode> = {
  usage: ExitCode.InvalidUsage,
  configuration: ExitCode.ConfigurationFailure,
  infrastructure: ExitCode.InfrastructureFailure,
  policy: ExitCode.PolicyFailure,
  "test-failure": ExitCode.TestFailure,
  internal: ExitCode.Internal,
};

export interface SmartTestErrorOptions {
  /** Stable, documented identifier, e.g. "ST_CONFIG_INVALID". */
  code: string;
  category: ErrorCategory;
  /** Actionable next step shown to the user. */
  hint?: string;
  cause?: unknown;
}

export class SmartTestError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly hint: string | undefined;

  constructor(message: string, options: SmartTestErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SmartTestError";
    this.code = options.code;
    this.category = options.category;
    this.hint = options.hint;
  }

  get exitCode(): ExitCode {
    return exitCodeByCategory[this.category];
  }
}

export function toExitCode(error: unknown): ExitCode {
  return error instanceof SmartTestError ? error.exitCode : ExitCode.Internal;
}
