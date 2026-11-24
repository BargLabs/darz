// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Check 1 judged only the gate files that exist at the head. Two
// kinds of path that do not exist yet can change the gate: a CODEOWNERS file
// in a location GitHub reads before the one in use, and a new file in a gate
// directory. Darz now judges a synthetic probe path for each.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import { DEFAULT_GATE_PATTERNS, directoryProbes, gateSet, probePaths } from "../src/gates.js";
import { type Fixture, NOT_FOUND, REPO, fileBody, fixtureFetch, goodFixture, ok, tree } from "./fixtures/github.js";

const WORKFLOW_PROBE = ".github/workflows/darz-probe-new-workflow.yml";
const WORKFLOW_PROBE_YAML = ".github/workflows/darz-probe-new-workflow.yaml";
const ACTION_PROBE = ".github/actions/darz-probe-new-action/action.yml";
const ACTION_PROBE_YAML = ".github/actions/darz-probe-new-action/action.yaml";
/** The default directory probes, sorted as probePaths returns them. */
const DEFAULT_PROBES = [ACTION_PROBE_YAML, ACTION_PROBE, WORKFLOW_PROBE_YAML, WORKFLOW_PROBE];

async function run(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<Assessment> {
  return assess({
    repo: REPO,
    fetch: fixtureFetch(fx).fetch,
    agents: ["coder-agent"],
    now: () => new Date("2026-11-23T12:00:00Z"),
    ...extra,
  });
}

function row(a: Assessment, id: string): CheckRow {
  return a.checks.find((c) => c.id === id) as CheckRow;
}

const codes = (r: CheckRow) => r.reasons.map((x) => x.code);
const subjects = (r: CheckRow, code: string) => r.reasons.find((x) => x.code === code)?.subjects;

/** The good fixture with its CODEOWNERS text moved to `location`. */
function withCodeowners(location: "CODEOWNERS" | "docs/CODEOWNERS" | ".github/CODEOWNERS", text: string, paths?: string[]) {
  const fx = goodFixture();
  const others = (paths ?? [".github/workflows/ci.yml", "README.md", "src/index.ts", "vitest.config.ts"]).filter(
    (p) => !p.endsWith("CODEOWNERS"),
  );
  fx.tree = tree([location, ...others]);
  fx.codeowners = { [location]: ok(fileBody(location, text)) };
  if (location !== ".github/CODEOWNERS") fx.codeowners[".github/CODEOWNERS"] = NOT_FOUND;
  if (location === "docs/CODEOWNERS") fx.codeowners.CODEOWNERS = NOT_FOUND;
  return fx;
}

describe("probe paths", () => {
  it("the default gate directories each get a .yml and a .yaml probe", () => {
    expect(directoryProbes(".github/workflows/**")).toEqual([WORKFLOW_PROBE, WORKFLOW_PROBE_YAML]);
    expect(directoryProbes(".github/actions/**")).toEqual([ACTION_PROBE, ACTION_PROBE_YAML]);
  });

  it("a pattern that names a file at any depth has no gate directory, so no probe", () => {
    for (const p of DEFAULT_GATE_PATTERNS.filter((g) => g.startsWith("**/"))) expect(directoryProbes(p)).toEqual([]);
    expect(directoryProbes("Makefile")).toEqual([]);
    expect(directoryProbes("scripts/release.sh")).toEqual([]);
  });

  it("a user pattern under a literal directory gets a probe that the pattern matches", () => {
    expect(directoryProbes("ci/**")).toEqual(["ci/darz-probe-new-file"]);
    expect(directoryProbes("/ci/**")).toEqual(["ci/darz-probe-new-file"]);
    expect(directoryProbes("scripts/*.sh")).toEqual(["scripts/darz-probe-new-file.sh"]);
    expect(directoryProbes("ci/**/*.sh")).toEqual(["ci/darz-probe-new-file.sh"]);
    expect(directoryProbes("docs/*/conf.py")).toEqual(["docs/darz-probe-new-file/conf.py"]);
    expect(directoryProbes("tools/check-?.py")).toEqual(["tools/check-z.py"]);
  });

  it("CODEOWNERS locations GitHub reads before the one in use are probed; later ones are not", () => {
    const set = gateSet([], null);
    expect(probePaths(set, ".github/CODEOWNERS", [])).toEqual(DEFAULT_PROBES);
    expect(probePaths(set, "CODEOWNERS", [])).toEqual([".github/CODEOWNERS", ...DEFAULT_PROBES]);
    expect(probePaths(set, "docs/CODEOWNERS", [])).toEqual([
      ".github/CODEOWNERS",
      ...DEFAULT_PROBES,
      "CODEOWNERS",
    ]);
  });

  it("a probe path that exists in the tree is dropped: the real file is judged instead", () => {
    expect(probePaths(gateSet([], null), ".github/CODEOWNERS", [WORKFLOW_PROBE])).toEqual([ACTION_PROBE_YAML, ACTION_PROBE, WORKFLOW_PROBE_YAML]);
  });
});

describe("check 1 judges the probe paths", () => {
  it("a root CODEOWNERS that does not own .github/CODEOWNERS fails: adding that file replaces it", async () => {
    const fx = withCodeowners("CODEOWNERS", "/CODEOWNERS @alice\n/.github/workflows/ @alice\n/.github/actions/ @alice\n/vitest.config.ts @alice\n");
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["new_gate_paths_unowned"]);
    expect(subjects(r, "new_gate_paths_unowned")).toEqual([".github/CODEOWNERS"]);
  });

  it("docs/CODEOWNERS in use: both earlier locations are probed", async () => {
    const fx = withCodeowners("docs/CODEOWNERS", "/docs/CODEOWNERS @alice\n/.github/workflows/ @alice\n/.github/actions/ @alice\n/vitest.config.ts @alice\n");
    const r = row(await run(fx), "gate_files_owned");
    expect(subjects(r, "new_gate_paths_unowned")).toEqual([".github/CODEOWNERS", "CODEOWNERS"]);
  });

  it("owning only the existing workflow leaves a new workflow, and a new action, unowned", async () => {
    const fx = withCodeowners(".github/CODEOWNERS", "/.github/CODEOWNERS @alice\n/.github/workflows/ci.yml @alice\n/vitest.config.ts @alice\n");
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["new_gate_paths_unowned"]);
    expect(subjects(r, "new_gate_paths_unowned")).toEqual(DEFAULT_PROBES);
  });

  it("owning only .yml workflows and action.yml leaves a new .yaml workflow and action.yaml unowned", async () => {
    // GitHub runs .yaml workflows and reads action.yaml as well, so a .yml
    // probe alone would pass a CODEOWNERS that an agent can get around.
    const fx = withCodeowners(
      ".github/CODEOWNERS",
      "/.github/CODEOWNERS @alice\n/.github/workflows/*.yml @alice\n/.github/actions/**/action.yml @alice\n/vitest.config.ts @alice\n",
    );
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["new_gate_paths_unowned"]);
    expect(subjects(r, "new_gate_paths_unowned")).toEqual([
      ".github/actions/darz-probe-new-action/action.yaml",
      ".github/workflows/darz-probe-new-workflow.yaml",
    ]);
  });

  it("real unowned gate files and unowned probes are reported under their own reasons", async () => {
    const fx = withCodeowners(".github/CODEOWNERS", "/.github/CODEOWNERS @alice\n/.github/actions/ @alice\n");
    const r = row(await run(fx), "gate_files_owned");
    expect(codes(r)).toEqual(["gate_files_unowned", "new_gate_paths_unowned"]);
    expect(subjects(r, "gate_files_unowned")).toEqual([".github/workflows/ci.yml", "vitest.config.ts"]);
    expect(subjects(r, "new_gate_paths_unowned")).toEqual([WORKFLOW_PROBE_YAML, WORKFLOW_PROBE]);
  });

  it("a catch-all owner owns every probe, and the record lists what was probed", async () => {
    const fx = withCodeowners("CODEOWNERS", "* @alice\n");
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("pass");
    expect(r.details?.probedPaths).toEqual([".github/CODEOWNERS", ...DEFAULT_PROBES]);
    expect(r.details?.gateFiles).not.toContain(WORKFLOW_PROBE);
  });

  it("the good fixture still passes: /.github/ owns both directory probes", async () => {
    const r = row(await run(goodFixture()), "gate_files_owned");
    expect(r.status).toBe("pass");
    expect(r.details?.probedPaths).toEqual(DEFAULT_PROBES);
  });

  it("a user gate pattern under a directory is probed", async () => {
    const fx = goodFixture();
    const r = row(await run(fx, { gates: ["ci/**", "**/Makefile"] }), "gate_files_owned");
    expect(r.status).toBe("pass");
    expect(r.details?.probedPaths).toEqual([...DEFAULT_PROBES, "ci/darz-probe-new-file"]);
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "/.github/ @alice\n/vitest.config.ts @alice\n")) };
    const r2 = row(await run(fx, { gates: ["ci/**"] }), "gate_files_owned");
    expect(subjects(r2, "new_gate_paths_unowned")).toEqual(["ci/darz-probe-new-file"]);
  });

  it("a real file at a probe's path is judged as a gate file, not as a probe", async () => {
    const fx = goodFixture();
    fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml", WORKFLOW_PROBE, "vitest.config.ts"]);
    const r = row(await run(fx), "gate_files_owned");
    expect(r.details?.gateFiles).toContain(WORKFLOW_PROBE);
    expect(r.details?.probedPaths).toEqual([ACTION_PROBE_YAML, ACTION_PROBE, WORKFLOW_PROBE_YAML]);
  });

  it("an unowned probe fails even when the tree is truncated: its ownership does not depend on the tree", async () => {
    const fx = withCodeowners(".github/CODEOWNERS", "/.github/CODEOWNERS @alice\n/.github/workflows/ci.yml @alice\n");
    fx.tree = tree([".github/CODEOWNERS"], true);
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["new_gate_paths_unowned"]);
    expect(subjects(r, "new_gate_paths_unowned")).toEqual(DEFAULT_PROBES);
  });

  it("with no CODEOWNERS file there is nothing to probe against", async () => {
    const fx = goodFixture();
    fx.tree = tree(["README.md", "src/index.ts"]);
    fx.codeowners = { ".github/CODEOWNERS": NOT_FOUND, CODEOWNERS: NOT_FOUND, "docs/CODEOWNERS": NOT_FOUND };
    const r = row(await run(fx), "gate_files_owned");
    expect(codes(r)).toEqual(["no_codeowners_file"]);
    expect(r.details?.probedPaths).toEqual([]);
  });

  it("a probe whose last match is an unverified errored line is ambiguous, like a gate file", async () => {
    const text = "/.github/ @alice\n/vitest.config.ts @alice\n/.github/actions/ @alice @ghost\n";
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", text)) };
    fx.codeownersErrors = ok({
      errors: [{ line: 3, kind: "Unknown owner", source: "/.github/actions/ @alice @ghost\n", path: ".github/CODEOWNERS" }],
    });
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(subjects(r, "codeowners_error_ambiguous")).toEqual([ACTION_PROBE_YAML, ACTION_PROBE]);
  });
});

describe("check 3 judges the probe paths", () => {
  it("an agent that owns a gate directory owns new files there", async () => {
    const fx = goodFixture();
    fx.codeowners = {
      ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @alice\n/.github/actions/ @coder-agent\n")),
    };
    const r = row(await run(fx), "writer_not_approver");
    expect(r.status).toBe("fail");
    expect(subjects(r, "agent_is_code_owner")).toEqual([`coder-agent: ${ACTION_PROBE_YAML}, ${ACTION_PROBE}`]);
  });

  it("an agent that owns a higher-precedence CODEOWNERS location can replace the file in use", async () => {
    const fx = withCodeowners("CODEOWNERS", "* @alice\n/.github/CODEOWNERS @coder-agent\n");
    const r = row(await run(fx), "writer_not_approver");
    expect(r.status).toBe("fail");
    expect(subjects(r, "agent_is_code_owner")).toEqual(["coder-agent: .github/CODEOWNERS"]);
  });
});
