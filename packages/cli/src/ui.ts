import { emitKeypressEvents } from "node:readline";
import { SmartTestError } from "@smarttest/shared";

export interface IO {
  stdout: NodeJS.WriteStream | { write(s: string): unknown; isTTY?: boolean };
  stderr: NodeJS.WriteStream | { write(s: string): unknown; isTTY?: boolean };
  stdin?: NodeJS.ReadStream;
}

export function colorEnabled(io: IO): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR) return true;
  return !!io.stdout.isTTY;
}

export type Paint = (s: string | number) => string;
export interface Theme {
  cyan: Paint;
  violet: Paint;
  green: Paint;
  red: Paint;
  yellow: Paint;
  dim: Paint;
  bold: Paint;
  pass: Paint;
  fail: Paint;
  skip: Paint;
  warnPill: Paint;
}

export function theme(enabled: boolean): Theme {
  const wrap =
    (open: string, close: string): Paint =>
    (s) =>
      enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s);
  return {
    cyan: wrap("36", "39"),
    violet: wrap("35", "39"),
    green: wrap("32", "39"),
    red: wrap("31", "39"),
    yellow: wrap("33", "39"),
    dim: wrap("2", "22"),
    bold: wrap("1", "22"),
    pass: enabled ? (s) => `\u001b[30;42;1m ${s} \u001b[0m` : (s) => `[${s}]`,
    fail: enabled ? (s) => `\u001b[30;41;1m ${s} \u001b[0m` : (s) => `[${s}]`,
    skip: enabled ? (s) => `\u001b[37;100;1m ${s} \u001b[0m` : (s) => `[${s}]`,
    warnPill: enabled ? (s) => `\u001b[30;43;1m ${s} \u001b[0m` : (s) => `[${s}]`,
  };
}

export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private text = "";
  constructor(
    private readonly io: IO,
    private readonly enabled: boolean,
  ) {}
  start(text: string): void {
    this.text = text;
    if (!this.enabled || this.timer) return;
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this.timer = setInterval(() => {
      this.io.stderr.write(`\r${frames[this.frame++ % frames.length]} ${this.text}\u001b[K`);
    }, 80);
  }
  update(text: string): void {
    this.text = text;
  }
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.io.stderr.write("\r\u001b[K");
    }
  }
}

function requireTTY(io: IO): NodeJS.ReadStream {
  const stdin = io.stdin ?? process.stdin;
  if (!stdin.isTTY) {
    throw new SmartTestError("Interactive input required but stdin is not a terminal", {
      code: "ST_INTERACTIVE_REQUIRED",
      category: "configuration",
      hint: "Pass the required flags (e.g. --yes) or use --non-interactive.",
    });
  }
  return stdin;
}

export async function select<T extends string>(
  io: IO,
  t: Theme,
  question: string,
  choices: { value: T; label: string; hint?: string }[],
  initial = 0,
): Promise<T> {
  const stdin = requireTTY(io);
  let index = initial;
  let filter = "";
  const visible = () => choices.filter((c) => c.label.toLowerCase().includes(filter.toLowerCase()));
  let lines = 0;
  const render = () => {
    if (lines) io.stdout.write(`\u001b[${lines}A\u001b[0J`);
    const v = visible();
    index = Math.min(index, Math.max(0, v.length - 1));
    const out = [`${t.cyan("?")} ${t.bold(question)}${filter ? t.dim(`  /${filter}`) : ""}`];
    for (const [i, c] of v.entries()) {
      out.push(
        `${i === index ? t.cyan("❯") : " "} ${i === index ? t.bold(c.label) : c.label}${c.hint ? t.dim(`  ${c.hint}`) : ""}`,
      );
    }
    out.push(t.dim("↑↓ navigate · enter select · type to search · esc cancel"));
    io.stdout.write(`${out.join("\n")}\n`);
    lines = out.length;
  };
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  render();
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      stdin.off("keypress", onKey);
      stdin.setRawMode(false);
      stdin.pause();
      fn();
    };
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      const v = visible();
      if ((key.ctrl && key.name === "c") || key.name === "escape")
        return done(() =>
          reject(new SmartTestError("Cancelled", { code: "ST_CANCELLED", category: "usage" })),
        );
      if (key.name === "up") index = (index - 1 + v.length) % Math.max(1, v.length);
      else if (key.name === "down") index = (index + 1) % Math.max(1, v.length);
      else if (key.name === "return") {
        const choice = v[index];
        if (choice) return done(() => resolve(choice.value));
      } else if (key.name === "backspace") filter = filter.slice(0, -1);
      else if (str && /^[\w\s./-]$/.test(str) && str !== "/") filter += str;
      render();
    };
    stdin.on("keypress", onKey);
  });
}

export async function confirm(
  io: IO,
  t: Theme,
  question: string,
  defaultValue = true,
): Promise<boolean> {
  return (
    (await select(
      io,
      t,
      question,
      [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      defaultValue ? 0 : 1,
    )) === "yes"
  );
}

export async function prompt(io: IO, t: Theme, question: string): Promise<string> {
  const stdin = requireTTY(io);
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: stdin, output: io.stdout as NodeJS.WriteStream });
  try {
    return (await rl.question(`${t.cyan("?")} ${t.bold(question)} `)).trim();
  } finally {
    rl.close();
  }
}

export function pad(s: string, n: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes to measure visible width
  const visible = s.replace(/\u001b\[[0-9;]*m/g, "");
  return visible.length >= n ? s : s + " ".repeat(n - visible.length);
}
