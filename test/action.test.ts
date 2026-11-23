// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTION_INPUTS, actionExitCode, inputsToRun, runAction } from "../src/action.js";
import { FORBIDDEN, NOT_FOUND, REPO, fixtureFetch, goodFixture, pullRequestRule, statusChecksRule } from "./fixtures/github.js";

const SENTINEL = "ghs_DARZ_ACTION_SENTINEL_never_print_0123456789";
const root = fileURLToPath(new URL("..", import.meta.url));

function actionEnv(inputs: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "darz-action-"));
  const output = join(dir, "output.txt");
  const summary = join(dir, "summary.md");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const env: Record<string, string> = {
    GITHUB_OUTPUT: output,
    GITHUB_STEP_SUMMARY: summary,
    "INPUT_REPOSITORY": REPO,
    "INPUT_TOKEN": SENTINEL,
    "INPUT_API-URL": "https://api.github.com",
    "INPUT_OUT-DIR": join(dir, "out"),
    "INPUT_FAIL-ON": "fail",
    "INPUT_MERGES": "50",
    "INPUT_AGENTS": "",
    "INPUT_AGENT-APPS": "",
    "INPUT_GATES": "",
  };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return { env, dir, output, summary };
}

async function act(fx = goodFixture(), inputs: Record<string, string> = { agents: "coder-agent" }) {
  const e = actionEnv(inputs);
  let stdout = "";
  let stderr = "";
  const f = fixtureFetch(fx);
  const code = await runAction({
    env: e.env,
    fetch: f.fetch,
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    now: () => new Date("2026-11-22T12:00:00Z"),
  });
  return {
    code,
    stdout,
    stderr,
    calls: f.calls,
    output: readFileSync(e.output, "utf8"),
    summary: readFileSync(e.summary, "utf8"),
    dir: e.dir,
  };
}

describe("inputs", () => {
  it("turn into CLI arguments, with the token passed only through the environment", () => {
    const { env } = actionEnv({ agents: "a-agent, b-agent\nc-agent", "agent-apps": "fixer", gates: "Makefile\n\n" });
    const run = inputsToRun(env);
    expect(run.argv).toEqual([
      REPO,
      "--api-url",
      "https://api.github.com",
      "--out",
      expect.stringMatching(/out$/),
      "--merges",
      "50",
      "--token-env",
      "DARZ_ACTION_TOKEN",
      "--agent",
      "a-agent",
      "--agent",
      "b-agent",
      "--agent",
      "c-agent",
      "--agent-app",
      "fixer",
      "--gate",
      "Makefile",
    ]);
    expect(run.argv.join(" ")).not.toContain(SENTINEL);
    expect(run.env).toEqual({ DARZ_ACTION_TOKEN: SENTINEL });
  });

  it("an unknown fail-on value is refused", () => {
    const { env } = actionEnv({ "fail-on": "sometimes" });
    expect(() => inputsToRun(env)).toThrow(/fail-on/);
  });

  it("every input action.yml declares is read, and every input read is declared", () => {
    const yml = readFileSync(join(root, "action.yml"), "utf8");
    const block = yml.slice(yml.indexOf("\ninputs:\n"), yml.indexOf("\noutputs:\n"));
    const declared = [...block.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((m) => m[1]);
    expect(declared.sort()).toEqual([...ACTION_INPUTS].sort());
  });

  it("action.yml runs the committed build on Node 24", () => {
    const yml = readFileSync(join(root, "action.yml"), "utf8");
    expect(yml).toMatch(/^runs:\n {2}using: node24\n {2}main: dist\/action\.js$/m);
  });
});

describe("exit codes", () => {
  const cases: Array<[string, number, number]> = [
    ["fail", 0, 0],
    ["fail", 1, 1],
    ["fail", 2, 0],
    ["fail", 3, 1],
    ["unverifiable", 2, 1],
    ["unverifiable", 0, 0],
    ["never", 1, 0],
    ["never", 2, 0],
    ["never", 3, 1],
    ["fail", 64, 1],
    ["never", 70, 1],
  ];
  for (const [failOn, darz, step] of cases) {
    it(`fail-on ${failOn}: darz exit ${darz} gives step exit ${step}`, () => {
      expect(actionExitCode(darz, failOn as "fail" | "unverifiable" | "never")).toBe(step);
    });
  }
});

describe("a run", () => {
  it("writes the outputs GitHub Actions reads", async () => {
    const r = await act();
    expect(r.code).toBe(0);
    const out = Object.fromEntries(r.output.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
    expect(out["exit-code"]).toBe("0");
    expect(out.pass).toBe("5");
    expect(out.fail).toBe("0");
    expect(out.unverifiable).toBe("0");
    expect(out.record).toMatch(/darz-record\.json$/);
    expect(out.sarif).toMatch(/darz\.sarif$/);
    expect(out["record-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes a job summary with one row per check", async () => {
    const r = await act();
    for (const id of ["gate_files_owned", "human_review_required", "writer_not_approver", "agents_cannot_bypass", "required_checks_fail_closed", "agent_merges_touching_gates"]) {
      expect(r.summary).toContain(`\`${id}\``);
    }
  });

  it("frames rows the token cannot read as a way to a full check, not an alarm", async () => {
    const fx = goodFixture();
    fx.classic = NOT_FOUND;
    fx.collaborators = FORBIDDEN;
    const r = await act(fx);
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/Administration: read/);
    expect(r.summary).toMatch(/full check/);
    expect(r.stdout).toMatch(/::notice/);
    expect(r.stdout).not.toMatch(/::error/);
  });

  it("says nothing about the token when every setting was read", async () => {
    const r = await act();
    expect(r.summary).not.toMatch(/Administration: read/);
  });

  it("fails the step when a check fails, with an error annotation", async () => {
    const fx = goodFixture();
    fx.rules = [[pullRequestRule({ required_approving_review_count: 0 }), statusChecksRule(["test"])]];
    const r = await act(fx);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error/);
  });

  it("never prints or writes the token", async () => {
    const fx = goodFixture();
    fx.collaborators = { status: 403, body: { message: `bad ${SENTINEL}` } };
    const r = await act(fx);
    for (const [name, text] of Object.entries({ stdout: r.stdout, stderr: r.stderr, output: r.output, summary: r.summary })) {
      expect(text, name).not.toContain(SENTINEL);
    }
    expect(readFileSync(join(r.dir, "out", "darz-record.json"), "utf8")).not.toContain(SENTINEL);
    expect(r.calls[0]?.headers.authorization).toBe(`Bearer ${SENTINEL}`);
  });

  it("makes GET requests to the API URL only", async () => {
    const r = await act();
    expect(r.calls.every((c) => c.method === "GET" && c.url.startsWith("https://api.github.com/"))).toBe(true);
  });
});
