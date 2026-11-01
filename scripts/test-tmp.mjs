// Vitest global setup: the tests copy fixtures and create repositories under os.tmpdir(), and many
// of them leave those directories behind. vitest.config.ts points TMPDIR (TEMP/TMP on Windows) at a
// directory of this run; this removes it when the run ends, so runs never pile up in /tmp (on a
// tmpfs they used up every inode).
import { rm } from "node:fs/promises";

export default function setup() {
  return async () => {
    const dir = process.env.SMARTTEST_TEST_TMP;
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  };
}
