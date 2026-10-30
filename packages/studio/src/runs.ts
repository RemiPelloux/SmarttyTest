/**
 * Runs started from Studio. One run at a time (a second request gets a conflict, not a queue),
 * streamed to the browser as it happens: phases, runner groups, then one result per file.
 */
import { randomUUID } from "node:crypto";
import type { SmartTest } from "@smarttest/core";
import { type SafetyMode, SmartTestError } from "@smarttest/shared";
import type { ExecutionEvent } from "@smarttest/test-executor";
import type { ChangeSource } from "@smarttest/vcs-core";
import type { StudioRun, StudioRunEvent } from "./contracts.js";
import { runFromReport, runVerdictOf } from "./snapshot.js";

export interface RunInput {
  scope: "affected" | "all" | "file";
  file?: string;
  /** Paths the caller believes are tests; a file outside them is refused before anything runs. */
  knownTests: readonly string[];
  mode?: SafetyMode;
  cache?: boolean;
  coverage?: boolean;
  bail?: boolean;
  source?: ChangeSource;
}

export type RunStreamEvent = StudioRunEvent & { runId: string };

type Listener = (event: RunStreamEvent) => void;

const MAX_EVENTS = 4_000;
/** Finished runs kept for `GET /api/runs` and their event logs; older ones are dropped. */
const MAX_FINISHED_RUNS = 10;

export class RunManager {
  private readonly runs = new Map<string, StudioRun>();
  private readonly events = new Map<string, StudioRunEvent[]>();
  private readonly listeners = new Set<Listener>();
  private controller: AbortController | null = null;
  private running: string | null = null;
  private completion: Promise<void> | null = null;

  constructor(
    private readonly st: SmartTest,
    private readonly onFinished: () => void = () => {},
  ) {}

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get activeId(): string | null {
    return this.running;
  }

  get(id: string): StudioRun | undefined {
    return this.runs.get(id);
  }

  eventsOf(id: string): StudioRunEvent[] {
    return this.events.get(id) ?? [];
  }

  recent(limit = 10): StudioRun[] {
    return [...this.runs.values()].slice(-limit).reverse();
  }

  cancel(id: string): boolean {
    if (this.running !== id) return false;
    this.controller?.abort();
    return true;
  }

  /** Creates the run and returns immediately; progress arrives on the stream. */
  start(input: RunInput): StudioRun {
    if (this.running)
      throw new SmartTestError("A run is already in progress in this Studio session", {
        code: "ST_STUDIO_BUSY",
        category: "usage",
        hint: "Wait for it to finish or cancel it.",
      });
    if (input.scope === "file") {
      if (!input.file)
        throw new SmartTestError("A single-file run needs a file", {
          code: "ST_STUDIO_RUN_INPUT",
          category: "usage",
        });
      if (!input.knownTests.includes(input.file))
        throw new SmartTestError(`${input.file} is not a discovered test file`, {
          code: "ST_STUDIO_RUN_INPUT",
          category: "usage",
          hint: "Pick a file from the tests list.",
        });
    }
    const id = `run_${randomUUID().slice(0, 8)}`;
    const run: StudioRun = {
      id,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      state: "queued",
      scope: input.scope,
      scopeFile: input.file ?? null,
      command:
        input.scope === "file"
          ? `smarttest run ${input.file}`
          : input.scope === "all"
            ? "smarttest run --all"
            : "smarttest run",
      mode: input.mode ?? this.st.config.mode,
      source: "",
      selected: 0,
      skippedBySelection: 0,
      summary: null,
      coverage: null,
      executions: [],
      warnings: [],
      integrityIssues: [],
      error: null,
    };
    this.runs.set(id, run);
    this.events.set(id, []);
    this.running = id;
    this.prune();
    this.controller = new AbortController();
    const completion = this.execute(run, input, this.controller.signal);
    this.completion = completion;
    void completion.finally(() => {
      if (this.completion === completion) this.completion = null;
    });
    return run;
  }

  /** Cancels an active run and waits (bounded) for the executor to wind down. */
  async close(timeoutMs = 2_000): Promise<void> {
    const active = this.running;
    if (active) this.cancel(active);
    const completion = this.completion;
    if (!completion) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      completion,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Keeps the active run and the most recent finished ones; maps iterate oldest first. */
  private prune(): void {
    let excess = this.runs.size - MAX_FINISHED_RUNS - (this.running ? 1 : 0);
    for (const id of this.runs.keys()) {
      if (excess <= 0) break;
      if (id === this.running) continue;
      this.runs.delete(id);
      this.events.delete(id);
      excess--;
    }
  }

  private update(run: StudioRun, patch: Partial<StudioRun>): void {
    Object.assign(run, patch);
  }

  private emit(run: StudioRun, event: StudioRunEvent): void {
    const list = this.events.get(run.id) ?? [];
    list.push(event);
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    this.events.set(run.id, list);
    for (const listener of this.listeners) listener({ ...event, runId: run.id });
  }

  private async execute(run: StudioRun, input: RunInput, signal: AbortSignal): Promise<void> {
    const phase = (state: StudioRun["state"], message: string) => {
      this.update(run, { state });
      this.emit(run, { type: "phase", at: new Date().toISOString(), phase: state, message });
    };
    try {
      phase("analysing", "Selecting tests for the current change");
      const outcome = await this.st.run({
        ...(input.source ? { source: input.source } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.scope === "all" ? { all: true } : {}),
        ...(input.cache !== undefined ? { cache: input.cache } : {}),
        ...(input.coverage !== undefined ? { coverage: input.coverage } : {}),
        ...(input.bail !== undefined ? { bail: input.bail } : {}),
        ...(input.scope === "file"
          ? { notes: [`Single-file run requested in Studio: ${input.file ?? ""}`] }
          : {}),
        signal,
        onAnalysis: (analysis) => {
          if (input.scope === "file" && input.file) {
            const file = input.file;
            if (!analysis.testFiles.includes(file))
              throw new SmartTestError(`${file} is not part of this project's tests`, {
                code: "ST_STUDIO_RUN_INPUT",
                category: "usage",
                hint: "Refresh Studio and pick the file again.",
              });
            analysis.decision.selectedTests = [
              {
                testId: file,
                filePath: file,
                reasons: [{ kind: "rule-match", message: "Run requested for this file in Studio" }],
              },
            ];
            analysis.decision.skippedTests = analysis.testFiles
              .filter((test) => test !== file)
              .map((test) => ({
                testId: test,
                filePath: test,
                reasons: ["Not part of this single-file run"],
              }));
          }
          const selected = analysis.decision.selectedTests.map((t) => t.filePath);
          this.update(run, {
            selected: selected.length,
            skippedBySelection: analysis.decision.skippedTests.length,
            source: analysis.input.description,
          });
          this.emit(run, {
            type: "selection",
            at: new Date().toISOString(),
            selected: selected.length,
            skipped: analysis.decision.skippedTests.length,
            analysisMs: Math.round(Object.values(analysis.timings).reduce((a, b) => a + b, 0)),
            analysisStatus: analysis.decision.analysisStatus,
            files: selected.slice(0, 400),
          });
        },
        onEvent: (event: ExecutionEvent) => this.onExecutionEvent(run, event),
      });
      this.update(run, { state: "done", finishedAt: new Date().toISOString() });
      const finished = runFromReport(
        outcome.report,
        input.scope,
        input.file ?? null,
        outcome.integrityIssues,
      );
      this.update(run, {
        ...finished,
        // The run was opened under Studio's own id; the report generates its own. Keep the id the
        // client already holds so `GET /api/runs/:id` and the final event stay addressable.
        id: run.id,
        state: "done",
        startedAt: run.startedAt,
        scope: input.scope,
        scopeFile: input.file ?? null,
        command: run.command,
      });
      for (const execution of finished.executions)
        this.emit(run, { type: "result", at: new Date().toISOString(), execution });
      if (finished.summary) {
        const status = runVerdictOf(
          finished.summary,
          finished.executions.length,
          finished.integrityIssues,
        );
        this.emit(run, {
          type: "summary",
          at: new Date().toISOString(),
          summary: finished.summary,
          status,
        });
      }
      this.emit(run, { type: "done", at: new Date().toISOString(), run: { ...run } });
    } catch (error) {
      const aborted = signal.aborted;
      if (aborted) {
        this.update(run, {
          state: "cancelled",
          finishedAt: new Date().toISOString(),
          summary: null,
        });
        this.emit(run, {
          type: "phase",
          at: new Date().toISOString(),
          phase: "cancelled",
          message: "Run cancelled",
        });
        this.emit(run, { type: "done", at: new Date().toISOString(), run: { ...run } });
      } else {
        const e = error as { code?: string; message?: string; hint?: string };
        const dto = {
          code: typeof e.code === "string" ? e.code : "ST_STUDIO_RUN",
          message: e.message ?? "The run failed",
          hint: e.hint ?? null,
        };
        this.update(run, {
          state: "failed",
          finishedAt: new Date().toISOString(),
          error: dto,
        });
        this.emit(run, { type: "error", at: new Date().toISOString(), error: dto });
        this.emit(run, { type: "done", at: new Date().toISOString(), run: { ...run } });
      }
    } finally {
      this.running = null;
      this.controller = null;
      this.prune();
      this.onFinished();
    }
  }

  private onExecutionEvent(run: StudioRun, event: ExecutionEvent): void {
    const at = new Date().toISOString();
    if (event.type === "group-start" || event.type === "group-end") {
      this.update(run, { state: "running" });
      this.emit(run, {
        type: "group",
        at,
        adapter: event.group.adapter,
        dir: event.group.dir,
        files: event.files ?? event.group.files,
        phase: event.type === "group-start" ? "start" : "end",
      });
      return;
    }
    if (event.type === "retry")
      this.emit(run, {
        type: "retry",
        at,
        adapter: event.group.adapter,
        files: event.files ?? event.group.files,
        attempt: event.attempt ?? 0,
      });
  }
}
