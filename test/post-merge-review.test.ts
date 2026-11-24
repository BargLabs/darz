// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Findings from a review after merge. Each block names the finding it
// covers; every one was confirmed against main before the fix.

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { inputsToRun, isEntryPoint, runAction } from "../src/action.js";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import { ownersOf, parseCodeowners } from "../src/codeowners.js";
import { holdsTestSettings } from "../src/gates.js";
import {
  FORBIDDEN,
  type Fixture,
  GOOD_PR_PARAMS,
  NOT_FOUND,
  OWNER,
  REPO,
  fixtureFetch,
  goodFixture,
  ok,
  pullRequestRule,
  statusChecksRule,
} from "./fixtures/github.js";

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
  const r = a.checks.find((c) => c.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

const codes = (r: CheckRow) => r.reasons.map((x) => x.code);

function pinnedTo(appId: number | null): Fixture {
  const fx = goodFixture();
  fx.rules = [[pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test"], true, 42, appId)]];
  return fx;
}

describe("check 5 cannot pass while it cannot tell which app is the agent", () => {
  it("a declared agent app whose lookup failed: a pinned check may be pinned to it, so unverifiable", async () => {
    const fx = pinnedTo(555);
    fx.apps = { "coder-app": FORBIDDEN };
    const r = row(await run(fx, { agents: [], agentApps: ["coder-app"] }), "required_checks_fail_closed");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["agent_app_unresolved"]);
  });

  it("a declared app id that GitHub contradicts is unverifiable, not a pass on the declared id", async () => {
    const fx = pinnedTo(777);
    fx.apps = { "coder-app": ok({ id: 777, slug: "coder-app" }) };
    const r = row(await run(fx, { agents: [], agentApps: ["coder-app=555"] }), "required_checks_fail_closed");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["agent_app_id_mismatch"]);
  });

  it("no agent identities and a pinned check: unverifiable, no_agent_identities", async () => {
    const r = row(await run(pinnedTo(555), { agents: [] }), "required_checks_fail_closed");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["no_agent_identities"]);
  });

  it("an unpinned check still fails, whatever is known about the agents", async () => {
    const r = row(await run(pinnedTo(null), { agents: [] }), "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["required_check_unpinned"]);
  });

  it("with the agent known and the check pinned to another app, it still passes", async () => {
    expect(row(await run(pinnedTo(555)), "required_checks_fail_closed").status).toBe("pass");
  });
});

function adminRepoToken(fx: Fixture): Fixture {
  fx.repo = ok(
    {
      full_name: REPO,
      default_branch: "main",
      private: true,
      owner: { login: OWNER, type: "Organization" },
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    },
    { "x-oauth-scopes": "repo" },
  );
  fx.classic = NOT_FOUND;
  return fx;
}

describe("a 404 proves classic protection absent only when nothing contradicts it", () => {
  it("the branch read failed, so the 404 may be 'branch not found': unreadable", async () => {
    const fx = adminRepoToken(goodFixture());
    fx.branch = { status: 500, body: {} };
    expect((await run(fx)).classicProtection.state).toBe("unreadable");
  });

  it("the branch is protected but the effective rules are empty: classic protection must exist, so unreadable", async () => {
    const fx = adminRepoToken(goodFixture());
    fx.rules = [[]];
    expect((await run(fx)).classicProtection.state).toBe("unreadable");
  });

  it("a protected branch with rules, and the 404: still absent", async () => {
    expect((await run(adminRepoToken(goodFixture()))).classicProtection).toEqual({
      state: "absent",
      basis: "admin_token_with_repo_scope",
    });
  });
});

function actionEnv(dir: string, inputs: Record<string, string>) {
  const output = join(dir, "output.txt");
  const summary = join(dir, "summary.md");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const env: Record<string, string> = {
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    INPUT_REPOSITORY: REPO,
    "INPUT_OUT-DIR": join(dir, "out"),
    "INPUT_FAIL-ON": "fail",
    INPUT_AGENTS: "coder-agent",
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return { env, output, summary };
}

describe("the Action never reports a record this run did not write", () => {
  it("a run that stops before writing does not publish the previous run's record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "darz-action-"));
    const first = actionEnv(dir, {});
    const io = { fetch: fixtureFetch(goodFixture()).fetch, stdout: () => {}, stderr: () => {}, now: () => new Date("2026-11-23T12:00:00Z") };
    expect(await runAction({ ...io, env: first.env })).toBe(0);

    const second = actionEnv(dir, { merges: "0" });
    let stdout = "";
    const code = await runAction({ ...io, env: second.env, stdout: (s) => (stdout += s) });
    expect(code).toBe(1);
    expect(readFileSync(second.output, "utf8")).toBe("");
    expect(readFileSync(second.summary, "utf8")).toBe("");
    expect(stdout).toMatch(/without writing a record/);
  });

  it("a repository input that looks like an option is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "darz-action-"));
    expect(() => inputsToRun(actionEnv(dir, { repository: "-h" }).env)).toThrow(/repository/);
  });
});

describe("the Action recognises itself as the entry script through symlinks", () => {
  it("a symlinked path to the same file is the entry point", () => {
    const dir = mkdtempSync(join(tmpdir(), "darz-entry-"));
    mkdirSync(join(dir, "real"));
    const file = join(dir, "real", "action.js");
    writeFileSync(file, "");
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(isEntryPoint(pathToFileURL(file).href, join(dir, "link", "action.js"))).toBe(true);
    expect(isEntryPoint(pathToFileURL(file).href, join(dir, "real", "other.js"))).toBe(false);
    expect(isEntryPoint(pathToFileURL(file).href, undefined)).toBe(false);
  });
});

describe("test-settings detection", () => {
  it("a quoted test key in vite.config is test settings", () => {
    expect(holdsTestSettings("vite.config.ts", `export default defineConfig({ "test": { coverage: {} } });\n`)).toBe(true);
    expect(holdsTestSettings("vite.config.js", `export default { 'test': { environment: 'node' } };\n`)).toBe(true);
  });

  it("a package.json that starts with a byte-order mark is read", () => {
    expect(holdsTestSettings("package.json", `﻿${JSON.stringify({ scripts: { test: "vitest run" } })}`)).toBe(true);
  });
});

describe("a flagged CODEOWNERS line whose handling is not verified stays ambiguous", () => {
  it("valid owners on a line flagged with no column could own the path, with no earlier owner", () => {
    const f = parseCodeowners("/.github/ @alice @ghost\n", [{ line: 1, kind: "Unknown owner" }]);
    expect(ownersOf(f, ".github/workflows/ci.yml")).toEqual({ owners: [], line: 1, ambiguous: true });
  });

  it("an all-unknown line before an unverified one does not make the result definite", () => {
    const f = parseCodeowners("* @alice\n/probe/ @ghost\n/probe/a.txt @bob @ghost2\n", [
      { line: 2, column: 9, kind: "Unknown owner" },
      { line: 3, kind: "Unknown owner" },
    ]);
    expect(ownersOf(f, "probe/a.txt")).toEqual({ owners: [], line: 3, ambiguous: true });
  });

  it("every owner flagged with a kind not verified and no earlier owner: both readings leave the path unowned, so not ambiguous", () => {
    const f = parseCodeowners("/x/ @a @b\n", [
      { line: 1, column: 5, kind: "Something new" },
      { line: 1, column: 8, kind: "Unknown owner" },
    ]);
    expect(ownersOf(f, "x/y")).toEqual({ owners: [], line: 1, ambiguous: false });
  });
});
