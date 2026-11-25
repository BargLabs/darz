// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Check 1 lists pull-request workflows that hold checks: write. Such a workflow,
// if it runs pull-request code, lets a pull request post a check run as GitHub
// Actions without changing a workflow file: the path check 5 names but cannot
// read. The signal is context, not pass or fail.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import type { FakeResponse } from "./helpers/fake-fetch.js";
import { type Fixture, REPO, SERVER_ERROR, fixtureFetch, goodFixture, ok, tree } from "./fixtures/github.js";

const R = `/repos/${REPO}`;

async function run(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<Assessment> {
  return assess({ repo: REPO, fetch: fixtureFetch(fx).fetch, agents: ["coder-agent"], now: () => new Date("2026-11-24T12:00:00Z"), ...extra });
}
function check1(a: Assessment): CheckRow {
  return a.checks.find((c) => c.id === "gate_files_owned") as CheckRow;
}
const line = (a: Assessment, start: string) => check1(a).context.find((c) => c.startsWith(start));

/** goodFixture with the two workflow files given bodies, and an optional default-permissions response. */
function withWorkflows(ci: string, darz: string, defaultPerms?: FakeResponse): Fixture {
  const fx = goodFixture();
  fx.blobs[".github/workflows/ci.yml"] = ci;
  fx.blobs[".github/workflows/darz.yml"] = darz;
  if (defaultPerms) fx.extra[`${R}/actions/permissions/workflow`] = defaultPerms;
  return fx;
}

const PLAIN = "on: push\npermissions:\n  contents: read\n";
const DEFAULT_PR = "on: pull_request\njobs:\n  unit:\n    runs-on: ubuntu-latest\n";
const UNDECIDED = "Workflows whose checks: write grant on a pull request could not be decided";

describe("check 1 lists pull-request workflows with checks: write", () => {
  it("names a workflow that grants it, as context, not a fail", async () => {
    const a = await run(withWorkflows("on: pull_request\npermissions:\n  checks: write\n", PLAIN));
    const l = line(a, "Workflows triggered by a pull request that hold checks: write");
    expect(l).toContain(".github/workflows/ci.yml");
    expect(l).not.toContain(".github/workflows/darz.yml");
    expect(check1(a).details?.pullRequestWorkflowsWithChecksWrite).toEqual([".github/workflows/ci.yml"]);
    // Context only: the workflow signal never changes the row's status by itself.
    expect(l).toContain("check 5");
  });

  it("says nothing when no pull-request workflow grants it", async () => {
    const a = await run(withWorkflows(PLAIN, "on: pull_request\npermissions:\n  contents: read\n"));
    expect(line(a, "Workflows triggered by a pull request that hold checks: write")).toBeUndefined();
    expect(check1(a).details?.pullRequestWorkflowsWithChecksWrite).toEqual([]);
  });

  it("ignores a checks: write workflow that is not triggered by a pull request", async () => {
    const a = await run(withWorkflows("on: push\npermissions:\n  checks: write\n", PLAIN));
    expect(line(a, "Workflows triggered by a pull request that hold checks: write")).toBeUndefined();
  });

  it("a workflow whose grant is the repository default is undecided without admin", async () => {
    // No default-permissions route served, so the read is not permitted.
    const a = await run(withWorkflows("on: pull_request\njobs:\n  unit:\n    runs-on: ubuntu-latest\n", PLAIN));
    const l = line(a, UNDECIDED);
    expect(l).toBe(
      `${UNDECIDED} (no permissions are set, so the repository's default workflow permissions apply, and GET /repos/{owner}/{repo}/actions/permissions/workflow could not be read (it needs administration access)): .github/workflows/ci.yml.`,
    );
    expect(check1(a).details?.pullRequestWorkflowsWithChecksWrite).toEqual([]);
  });

  it("a default-permissions read of write resolves a default workflow to granted", async () => {
    const a = await run(
      withWorkflows("on: pull_request\njobs:\n  unit:\n    runs-on: ubuntu-latest\n", PLAIN, ok({ default_workflow_permissions: "write" })),
    );
    expect(check1(a).details?.pullRequestWorkflowsWithChecksWrite).toEqual([".github/workflows/ci.yml"]);
  });

  it("a default-permissions read of read resolves a default workflow to none", async () => {
    const a = await run(
      withWorkflows("on: pull_request\njobs:\n  unit:\n    runs-on: ubuntu-latest\n", PLAIN, ok({ default_workflow_permissions: "read" })),
    );
    expect(check1(a).details?.pullRequestWorkflowsWithChecksWrite).toEqual([]);
    expect(line(a, UNDECIDED)).toBeUndefined();
  });

  it("does not change the check's status", async () => {
    // goodFixture passes check 1; the signal is context, so it still passes.
    const a = await run(withWorkflows("on: pull_request\npermissions:\n  checks: write\n", PLAIN));
    expect(check1(a).status).toBe("pass");
  });

  it("a default-permissions response without a known value is not a read: the workflow stays undecided", async () => {
    const a = await run(withWorkflows(DEFAULT_PR, PLAIN, ok({})));
    expect(line(a, UNDECIDED)).toContain("could not be read (it needs administration access)): .github/workflows/ci.yml.");
    expect(check1(a).details?.pullRequestWorkflowsWithChecksWrite).toEqual([]);
  });

  it("an on: shape it does not read is undecided, not dropped", async () => {
    const a = await run(withWorkflows("on: |\n  pull_request\npermissions:\n  checks: write\n", PLAIN, ok({ default_workflow_permissions: "read" })));
    expect(line(a, UNDECIDED)).toBe(
      `${UNDECIDED} (a value Darz does not read: a block scalar, an alias, a merge key, a tag, a flow value spread over lines, or a value GitHub does not accept): .github/workflows/ci.yml.`,
    );
    expect(check1(a).details?.pullRequestWorkflowsUndecided).toEqual([".github/workflows/ci.yml"]);
  });

  it("a workflow file that could not be read is undecided with that reason, not called a shape", async () => {
    const fx = withWorkflows(PLAIN, PLAIN, ok({ default_workflow_permissions: "read" }));
    fx.blobs[".github/workflows/ci.yml"] = SERVER_ERROR;
    const a = await run(fx);
    expect(line(a, UNDECIDED)).toBe(`${UNDECIDED} (the file could not be read): .github/workflows/ci.yml.`);
  });

  it("gives each reason its own line when reasons are mixed", async () => {
    const fx = withWorkflows(DEFAULT_PR, "on: pull_request\npermissions: *p\n");
    fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml", ".github/workflows/darz.yml"]);
    const lines = check1(await run(fx)).context.filter((c) => c.startsWith(UNDECIDED));
    expect(lines).toEqual([
      expect.stringMatching(/a value Darz does not read.*: \.github\/workflows\/darz\.yml\.$/),
      expect.stringMatching(/administration access\)\): \.github\/workflows\/ci\.yml\.$/),
    ]);
  });

  it("reads workflows when the candidate files are over their cap", async () => {
    const fx = withWorkflows("on: pull_request\npermissions:\n  checks: write\n", PLAIN);
    const many = Array.from({ length: 501 }, (_, i) => `packages/p${i}/package.json`);
    fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml", ".github/workflows/darz.yml", ...many]);
    const r = check1(await run(fx));
    expect(r.details?.workflowSignal).toBe("complete");
    expect(r.details?.pullRequestWorkflowsWithChecksWrite).toEqual([".github/workflows/ci.yml"]);
  });

  it("reads workflows from a truncated tree, and says the list may be incomplete", async () => {
    const fx = withWorkflows("on: pull_request\npermissions:\n  checks: write\n", PLAIN);
    fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml", ".github/workflows/darz.yml"], true);
    const r = check1(await run(fx));
    expect(r.details?.workflowSignal).toBe("incomplete");
    expect(r.details?.pullRequestWorkflowsWithChecksWrite).toEqual([".github/workflows/ci.yml"]);
    expect(r.context).toContain(
      "GitHub truncated the tree, so the workflow files Darz read may not be all of them; the lists of pull-request workflows that hold checks: write may be incomplete.",
    );
  });

  it("over the workflow cap, says the signal was not computed and gives no list", async () => {
    const fx = goodFixture();
    fx.tree = tree([".github/CODEOWNERS", ...Array.from({ length: 501 }, (_, i) => `.github/workflows/w${i}.yml`)]);
    const r = check1(await run(fx));
    expect(r.details?.workflowSignal).toBe("not_computed");
    expect(r.details?.pullRequestWorkflowsWithChecksWrite).toBeNull();
    expect(r.context).toContain(
      "The default branch has 501 workflow files, 501 distinct; Darz reads at most 500, so pull-request workflows that hold checks: write are not listed.",
    );
  });

  it("with the tree unreadable, says the workflows were not read and gives no list", async () => {
    const fx = goodFixture();
    fx.tree = SERVER_ERROR;
    const r = check1(await run(fx));
    expect(r.details?.pullRequestWorkflowsWithChecksWrite).toBeNull();
    expect(r.context).toContain(
      "The workflow files were not read, because the tree was not read, so pull-request workflows that hold checks: write are not listed.",
    );
  });

  it("reads two workflow files with the same blob once", async () => {
    const fx = withWorkflows(PLAIN, PLAIN);
    const sha = "a".repeat(40);
    fx.tree = ok({
      sha: "x",
      tree: [".github/workflows/a.yml", ".github/workflows/b.yml"].map((path) => ({ path, mode: "100644", type: "blob", sha })),
      truncated: false,
    });
    fx.extra[`${R}/git/blobs/${sha}`] = ok({ sha, encoding: "base64", content: Buffer.from(PLAIN).toString("base64") });
    const f = fixtureFetch(fx);
    await assess({ repo: REPO, fetch: f.fetch, agents: ["coder-agent"], now: () => new Date("2026-11-24T12:00:00Z") });
    expect(f.calls.filter((c) => c.url.includes(`/git/blobs/${sha}`)).length).toBe(1);
  });
});
