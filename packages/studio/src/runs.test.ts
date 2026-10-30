import type { SmartTest } from "@smarttest/core";
import { expect, it } from "vitest";
import { RunManager } from "./runs.js";

it("keeps only the most recent finished runs and their events", async () => {
  const st = {
    config: { mode: "balanced" },
    run: async () => {
      throw new Error("no runner in this test");
    },
  } as unknown as SmartTest;
  const manager = new RunManager(st);
  const ids: string[] = [];
  for (let i = 0; i < 15; i++) {
    ids.push(manager.start({ scope: "affected", knownTests: [] }).id);
    await manager.close();
  }
  const recent = manager.recent(50);
  expect(recent).toHaveLength(10);
  expect(recent[0]?.id).toBe(ids[14]);
  expect(manager.get(ids[0] as string)).toBeUndefined();
  expect(manager.eventsOf(ids[0] as string)).toEqual([]);
  expect(manager.get(ids[14] as string)?.finishedAt).not.toBeNull();
  expect(manager.eventsOf(ids[14] as string).length).toBeGreaterThan(0);
});
