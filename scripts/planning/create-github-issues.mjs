#!/usr/bin/env node
/**
 * Creates GitHub labels, milestones (one per sprint) and issues (one per story) from backlog.data.mjs.
 *
 *   node scripts/planning/create-github-issues.mjs                    # dry run: prints what would happen
 *   node scripts/planning/create-github-issues.mjs --apply            # really create (requires `gh auth login`)
 *   node scripts/planning/create-github-issues.mjs --apply --sprint S0,S1
 *
 * Idempotent: issues whose title already starts with the story id are skipped.
 * Requires the GitHub CLI (`gh`) and a repository remote.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { release, sprints, epics, stories } = await import(
  pathToFileURL(join(repoRoot, "documentation/planning/foundation/backlog.data.mjs")).href
);

const apply = process.argv.includes("--apply");
const sprintArg = process.argv.find((_arg, i) => process.argv[i - 1] === "--sprint");
const sprintFilter = sprintArg ? new Set(sprintArg.split(",")) : null;
const selected = stories.filter((s) => !sprintFilter || sprintFilter.has(s.sprint));

const gh = (args, { allowFail = false } = {}) => {
  if (!apply) {
    console.log(
      `  gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a.length > 70 ? `${a.slice(0, 67)}...` : a) : a)).join(" ")}`,
    );
    return "";
  }
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowFail) return "";
    throw error;
  }
};

const epicName = new Map(epics.map((e) => [e.id, e.name]));
const milestoneTitle = (sprintId) => {
  const sp = sprints.find((s) => s.id === sprintId);
  return `v${release.version} · ${sp.id} ${sp.name}`;
};

console.log(apply ? "Applying to GitHub…" : "Dry run (pass --apply to create):");

console.log("\nLabels");
const labels = [
  ["story", "0E8A16", "User story"],
  ["spike", "FBCA04", "Time-boxed investigation"],
  [`release:${release.version}`, "5319E7", `Target release ${release.version}`],
  ["priority:must", "B60205", "MoSCoW: Must"],
  ["priority:should", "D93F0B", "MoSCoW: Should"],
  ["priority:could", "1D76DB", "MoSCoW: Could"],
  ...epics.map((e) => [`epic:${e.id}`, "22D3EE", e.name]),
];
for (const [name, color, description] of labels) {
  gh(["label", "create", name, "--color", color, "--description", description, "--force"], {
    allowFail: true,
  });
}

console.log("\nMilestones");
const usedSprints = [...new Set(selected.map((s) => s.sprint))];
for (const sp of usedSprints) {
  gh(
    [
      "api",
      "repos/{owner}/{repo}/milestones",
      "-f",
      `title=${milestoneTitle(sp)}`,
      "-f",
      `description=${sprints.find((s) => s.id === sp).goal}`,
    ],
    { allowFail: true },
  );
}

console.log("\nIssues");
const existing = apply
  ? new Set(
      JSON.parse(
        gh(["issue", "list", "--state", "all", "--limit", "1000", "--json", "title"]) || "[]",
      ).map((i) => i.title.split(" ")[0]),
    )
  : new Set();

for (const s of selected) {
  if (existing.has(s.id)) {
    console.log(`  skip ${s.id} (exists)`);
    continue;
  }
  const body = [
    `> As a **${s.as}**, I want **${s.want}**, so that **${s.so}**.`,
    "",
    `| Epic | Priority | Points | Sprint | Spec |`,
    `|---|---|---|---|---|`,
    `| ${s.epic} — ${epicName.get(s.epic)} | ${s.pri} | ${s.pts} | ${s.sprint} | ${s.refs.join(", ")} |`,
    "",
    "### Acceptance criteria",
    ...s.ac.map((a) => `- [ ] ${a}`),
    "",
    s.deps.length ? `**Depends on:** ${s.deps.join(", ")}` : "",
    "",
    "_Generated from `documentation/planning/foundation/backlog.data.mjs`._",
  ].join("\n");
  const labelsFor = [
    s.title.startsWith("Spike") ? "spike" : "story",
    `epic:${s.epic}`,
    `priority:${s.pri.toLowerCase()}`,
    `release:${release.version}`,
  ];
  gh([
    "issue",
    "create",
    "--title",
    `${s.id} ${s.title}`,
    "--body",
    body,
    "--milestone",
    milestoneTitle(s.sprint),
    ...labelsFor.flatMap((l) => ["--label", l]),
  ]);
}
console.log(`\n${selected.length} stories ${apply ? "processed" : "would be created"}.`);
