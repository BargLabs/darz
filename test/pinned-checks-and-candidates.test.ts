// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Issue 11: a required check any status poster can satisfy is not a gate.
// Issue 12: package.json, vite.config.*, pyproject.toml and setup.cfg are gate
// files when, and only when, they hold test or coverage settings.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import {
  FORBIDDEN,
  type Fixture,
  GOOD_PR_PARAMS,
  NOT_FOUND,
  REPO,
  classicProtection,
  fileBody,
  fixtureFetch,
  goodFixture,
  ok,
  pullRequestRule,
  statusChecksRule,
  tree,
} from "./fixtures/github.js";

async function run(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<Assessment> {
  return assess({
    repo: REPO,
    fetch: fixtureFetch(fx).fetch,
    agents: ["coder-agent"],
    now: () => new Date("2026-11-22T12:00:00Z"),
    ...extra,
  });
}

function row(a: Assessment, id: string): CheckRow {
  const r = a.checks.find((c) => c.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

const codes = (r: CheckRow) => r.reasons.map((x) => x.code);

function withRules(fx: Fixture, rules: unknown[]): Fixture {
  fx.rules = [rules];
  return fx;
}

describe("check 5: a required check must be pinned to the app that reports it (issue 11)", () => {
  it("an unpinned required check in the rules fails with required_check_unpinned", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test", "lint"], true, 42, null)]);
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["required_check_unpinned"]);
    expect(r.reasons[0]?.subjects).toEqual(["lint", "test"]);
    expect(r.details).toEqual({
      requiredChecks: [
        { context: "lint", appIds: [] },
        { context: "test", appIds: [] },
      ],
      mustBeUpToDate: true,
    });
  });

  it("only the unpinned checks are named when some are pinned", async () => {
    const fx = withRules(goodFixture(), [
      pullRequestRule(GOOD_PR_PARAMS),
      statusChecksRule(["test"]),
      statusChecksRule(["lint"], true, 42, null),
    ]);
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(r.reasons[0]?.subjects).toEqual(["lint"]);
  });

  it("a classic required check with app_id null is unpinned", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS)]);
    fx.classic = classicProtection({ contexts: ["build"], checkAppId: null });
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["required_check_unpinned"]);
  });

  it("a classic legacy contexts list, with no checks array, is unpinned", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS)]);
    fx.classic = classicProtection({ contexts: ["build"], legacyContextsOnly: true });
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(r.reasons[0]?.subjects).toEqual(["build"]);
  });

  it("a check pinned by any source is pinned, since GitHub enforces every source", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test"])]);
    fx.classic = classicProtection({ contexts: ["test"], checkAppId: null });
    expect(row(await run(fx), "required_checks_fail_closed").status).toBe("pass");
  });

  it("an unpinned check in the rules with classic protection unreadable is unverifiable, never pass or fail", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test"], true, 42, null)]);
    fx.classic = NOT_FOUND;
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["classic_protection_unreadable"]);
  });

  it("a check pinned to an agent app fails with required_check_pinned_to_agent_app", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test"], true, 42, 555)]);
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app" }) };
    const r = row(await run(fx, { agents: [], agentApps: ["coder-app"] }), "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["required_check_pinned_to_agent_app"]);
    expect(r.reasons[0]?.subjects).toEqual(["test: app coder-app (id 555)"]);
  });

  it("no required check still fails with no_required_checks", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS)]);
    expect(codes(row(await run(fx), "required_checks_fail_closed"))).toEqual(["no_required_checks"]);
  });
});

const OWN_ALL = "* @alice\n";
const OWN_GITHUB_ONLY = "/.github/ @alice\n/vitest.config.ts @alice\n";

function candidateFixture(files: Record<string, string>, codeowners = OWN_GITHUB_ONLY): Fixture {
  const fx = goodFixture();
  fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml", "src/index.ts", ...Object.keys(files)]);
  fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", codeowners)) };
  fx.blobs = { ...files };
  return fx;
}

describe("check 1: files that hold test or coverage settings are gate files (issue 12)", () => {
  const gates: Array<[string, string, string]> = [
    ["package.json with a test script", "package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } })],
    ["package.json with a test:unit script", "packages/a/package.json", JSON.stringify({ scripts: { "test:unit": "jest" } })],
    ["package.json with a coverage script", "package.json", JSON.stringify({ scripts: { coverage: "c8 npm test" } })],
    ["package.json with a jest block", "package.json", JSON.stringify({ name: "x", jest: { coverageThreshold: {} } })],
    ["package.json with an nyc block", "package.json", JSON.stringify({ name: "x", nyc: { "check-coverage": true } })],
    ["vite.config.ts with a test block", "vite.config.ts", "export default defineConfig({\n  test: { environment: 'node' },\n});\n"],
    ["pyproject.toml with pytest settings", "pyproject.toml", "[project]\nname = 'x'\n\n[tool.pytest.ini_options]\naddopts = '-q'\n"],
    ["pyproject.toml with coverage settings", "pyproject.toml", "[tool.coverage.run]\nbranch = true\n"],
    ["setup.cfg with pytest settings", "setup.cfg", "[metadata]\nname = x\n\n[tool:pytest]\naddopts = -q\n"],
    ["setup.cfg with coverage settings", "setup.cfg", "[coverage:run]\nbranch = True\n"],
  ];
  for (const [name, path, text] of gates) {
    it(`${name} is a gate file`, async () => {
      const r = row(await run(candidateFixture({ [path]: text })), "gate_files_owned");
      expect(r.status).toBe("fail");
      expect(r.reasons.find((x) => x.code === "gate_files_unowned")?.subjects).toEqual([path]);
    });
  }

  it("an owned candidate gate file passes", async () => {
    const fx = candidateFixture({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) }, OWN_ALL);
    expect(row(await run(fx), "gate_files_owned").status).toBe("pass");
  });

  const notGates: Array<[string, string, string]> = [
    ["package.json with no test settings", "package.json", JSON.stringify({ name: "x", scripts: { build: "tsc" }, dependencies: { a: "1" } })],
    ["vite.config.ts with no test block", "vite.config.ts", "export default defineConfig({ plugins: [] });\n"],
    ["pyproject.toml with only formatter settings", "pyproject.toml", "[tool.black]\nline-length = 100\n"],
    ["setup.cfg with only metadata", "setup.cfg", "[metadata]\nname = x\n"],
  ];
  for (const [name, path, text] of notGates) {
    it(`${name} is not a gate file, and is listed as context`, async () => {
      const r = row(await run(candidateFixture({ [path]: text })), "gate_files_owned");
      expect(r.status).toBe("pass");
      expect(r.details?.candidatesWithoutTestSettings).toEqual([path]);
    });
  }

  it("a candidate that cannot be read is unverifiable, never pass", async () => {
    const fx = candidateFixture({});
    fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml", "package.json"]);
    fx.blobs = { "package.json": FORBIDDEN };
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["gate_candidate_unreadable"]);
    expect(r.reasons[0]?.subjects).toEqual(["package.json"]);
  });

  it("a package.json that is not valid JSON is unverifiable", async () => {
    const r = row(await run(candidateFixture({ "package.json": "{ not json" })), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["gate_candidate_unreadable"]);
  });

  it("more candidates than Darz reads is unverifiable, naming the count", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 201; i++) files[`packages/p${i}/package.json`] = JSON.stringify({ name: `p${i}` });
    const r = row(await run(candidateFixture(files)), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["gate_candidates_over_cap"]);
    expect(r.reasons[0]?.subjects).toEqual(["201 candidates; at most 200 are read"]);
  });

  it("check 3 sees an agent that owns a candidate gate file", async () => {
    const fx = candidateFixture(
      { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) },
      "/.github/ @alice\n/package.json @coder-agent\n",
    );
    const r = row(await run(fx), "writer_not_approver");
    expect(r.status).toBe("fail");
    expect(r.reasons[0]?.subjects).toEqual(["coder-agent: package.json"]);
  });

  it("check 6 counts a change to a candidate gate file", async () => {
    const fx = candidateFixture({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) }, OWN_ALL);
    fx.pulls = [{ number: 7, author: "coder-agent", files: [["package.json", "src/index.ts"]] }];
    const r = row(await run(fx), "agent_merges_touching_gates");
    expect((r.details?.pullRequests as Array<{ gateFilesChanged: string[] }>)[0]?.gateFilesChanged).toEqual(["package.json"]);
  });
});
