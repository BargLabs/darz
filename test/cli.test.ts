// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { TOOL_VERSION } from "../src/version.js";
import { FORBIDDEN, NOT_FOUND, REPO, fixtureFetch, goodFixture, pullRequestRule, ruleset } from "./fixtures/github.js";
import { recordErrors, sarifErrors } from "./helpers/schemas.js";

const SENTINEL = "ghp_DARZ_SENTINEL_TOKEN_must_never_appear_0123456789";

async function cli(args: string[], fx = goodFixture(), env: Record<string, string> = { GITHUB_TOKEN: SENTINEL }, fetchOverride?: any) {
  const out = mkdtempSync(join(tmpdir(), "darz-test-"));
  let stdout = "";
  let stderr = "";
  const code = await main(["--out", out, ...args], {
    env,
    fetch: fetchOverride ?? fixtureFetch(fx).fetch,
    stdout: (s: string) => {
      stdout += s;
    },
    stderr: (s: string) => {
      stderr += s;
    },
    now: () => new Date("2026-11-20T12:00:00Z"),
  });
  const files = Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(join(out, f), "utf8")]));
  return { code, stdout, stderr, files, out };
}

describe("exit codes", () => {
  it("0: every check passed", async () => {
    const r = await cli([REPO, "--agent", "coder-agent"]);
    expect(r.code).toBe(0);
  });

  it("1: any check failed", async () => {
    const fx = goodFixture();
    fx.rules = [[pullRequestRule({ required_approving_review_count: 0 })]];
    expect((await cli([REPO, "--agent", "coder-agent"], fx)).code).toBe(1);
  });

  it("2: none failed, but at least one is unverifiable", async () => {
    const fx = goodFixture();
    fx.collaborators = FORBIDDEN;
    const r = await cli([REPO, "--agent", "coder-agent"], fx);
    expect(r.code).toBe(2);
  });

  it("2 and never 0 when the only unverifiable rows are no_agent_identities", async () => {
    const fx = goodFixture();
    fx.pulls = [{ number: 6, author: "alice", files: [["README.md"]] }];
    expect((await cli([REPO], fx)).code).toBe(2);
  });

  it("3: the repository itself could not be read", async () => {
    const fx = goodFixture();
    fx.repo = NOT_FOUND;
    const r = await cli([REPO, "--agent", "coder-agent"], fx);
    expect(r.code).toBe(3);
    expect(r.files["darz-record.json"]).toBeDefined();
  });

  it("64: a usage error", async () => {
    expect((await cli([])).code).toBe(64);
    expect((await cli(["not-a-repo"])).code).toBe(64);
    expect((await cli([REPO, "--merges", "0"])).code).toBe(64);
    expect((await cli([REPO, "--bogus"])).code).toBe(64);
    expect((await cli([REPO, "--agent-app", "coder-app=abc"])).code).toBe(64);
    expect((await cli([REPO, "--agent-app", "coder-app=0"])).code).toBe(64);
  });

  it("64: an empty value, in either form, never becomes an agent identity", async () => {
    for (const args of [["--agent="], ["--agent-app="], ["--agent", ""], ["--agent-app", ""], ["--gate="], ["--out="]]) {
      const r = await cli([REPO, ...args]);
      expect(r.code, args.join(" ")).toBe(64);
      expect(r.stderr).toMatch(/needs a value/);
    }
  });
});

describe("outputs", () => {
  it("prints one line per check and writes the record, its SHA-256 and the SARIF", async () => {
    const r = await cli([REPO, "--agent", "coder-agent"]);
    for (const id of [
      "gate_files_owned",
      "human_review_required",
      "writer_not_approver",
      "agents_cannot_bypass",
      "required_checks_fail_closed",
      "agent_merges_touching_gates",
    ]) {
      expect(r.stdout.split("\n").filter((l) => l.includes(id))).toHaveLength(1);
    }
    expect(Object.keys(r.files).sort()).toEqual(["darz-record.json", "darz-record.json.sha256", "darz.sarif"]);
    const record = r.files["darz-record.json"] as string;
    const { createHash } = await import("node:crypto");
    const hex = createHash("sha256").update(Buffer.from(record, "utf8")).digest("hex");
    expect(r.files["darz-record.json.sha256"]).toBe(`${hex}  darz-record.json\n`);
    expect(recordErrors(JSON.parse(record))).toEqual([]);
    expect(sarifErrors(JSON.parse(r.files["darz.sarif"] as string))).toEqual([]);
  });

  it("records the inputs needed to re-run", async () => {
    const r = await cli([REPO, "--agent", "coder-agent", "--agent-app", "fixer", "--gate", "Makefile", "--merges", "20"]);
    const rec = JSON.parse(r.files["darz-record.json"] as string);
    expect(rec.options).toEqual({
      agentApps: ["fixer"],
      agents: ["coder-agent"],
      gates: ["Makefile"],
      graphqlRulesetRoles: false,
      merges: 20,
      ref: null,
    });
  });

  const roleBypassFixture = () => {
    const fx = goodFixture();
    fx.rulesets = { 42: ruleset(42, [{ actor_id: 4, actor_type: "RepositoryRole", bypass_mode: "always" }]) };
    return fx;
  };

  it("--graphql-ruleset-roles is recorded, and without it Darz sends no POST", async () => {
    const f = fixtureFetch(roleBypassFixture());
    const out = mkdtempSync(join(tmpdir(), "darz-test-"));
    await main([REPO, "--out", out, "--agent", "coder-agent"], { env: {}, fetch: f.fetch, stdout: () => {}, stderr: () => {} });
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    const g = fixtureFetch(roleBypassFixture());
    const out2 = mkdtempSync(join(tmpdir(), "darz-test-"));
    await main([REPO, "--out", out2, "--agent", "coder-agent", "--graphql-ruleset-roles"], { env: {}, fetch: g.fetch, stdout: () => {}, stderr: () => {} });
    expect(g.calls.some((c) => c.method === "POST" && c.url === "https://api.github.com/graphql")).toBe(true);
    const rec = JSON.parse(readFileSync(join(out2, "darz-record.json"), "utf8"));
    expect(rec.options.graphqlRulesetRoles).toBe(true);
    expect(rec.reads.some((r: { endpoint: string }) => r.endpoint === "POST /graphql#rulesetBypassRoles")).toBe(true);
    expect(recordErrors(rec)).toEqual([]);
  });

  it("--graphql-ruleset-roles=true and =false are accepted; any other value is a usage error", async () => {
    for (const [arg, posts] of [["--graphql-ruleset-roles=true", true], ["--graphql-ruleset-roles=false", false]] as const) {
      const f = fixtureFetch(roleBypassFixture());
      const out = mkdtempSync(join(tmpdir(), "darz-test-"));
      const code = await main([REPO, "--out", out, "--agent", "coder-agent", arg], { env: {}, fetch: f.fetch, stdout: () => {}, stderr: () => {} });
      expect(code).not.toBe(64);
      expect(f.calls.some((c) => c.method === "POST")).toBe(posts);
      expect(JSON.parse(readFileSync(join(out, "darz-record.json"), "utf8")).options.graphqlRulesetRoles).toBe(posts);
    }
    let err = "";
    const code = await main([REPO, "--graphql-ruleset-roles=yes"], { env: {}, fetch: fixtureFetch(goodFixture()).fetch, stdout: () => {}, stderr: (s) => (err += s) });
    expect(code).toBe(64);
    expect(err).toMatch(/--graphql-ruleset-roles/);
  });

  it("options.graphqlRulesetRoles records what was asked; the reads say whether the reader ran", async () => {
    const fx = roleBypassFixture();
    fx.repo = NOT_FOUND;
    const f = fixtureFetch(fx);
    const out = mkdtempSync(join(tmpdir(), "darz-test-"));
    await main([REPO, "--out", out, "--agent", "coder-agent", "--graphql-ruleset-roles"], { env: {}, fetch: f.fetch, stdout: () => {}, stderr: () => {} });
    const rec = JSON.parse(readFileSync(join(out, "darz-record.json"), "utf8"));
    expect(rec.options.graphqlRulesetRoles).toBe(true);
    expect(rec.reads.some((r: { endpoint: string }) => r.endpoint.startsWith("POST "))).toBe(false);
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("--version prints the version", async () => {
    let s = "";
    const code = await main(["--version"], { env: {}, fetch: fixtureFetch(goodFixture()).fetch, stdout: (x) => (s += x), stderr: () => {} });
    expect(code).toBe(0);
    expect(s.trim()).toBe(`darz ${TOOL_VERSION}`);
  });
});

describe("the token", () => {
  function assertAbsent(r: { stdout: string; stderr: string; files: Record<string, string> }) {
    expect(r.stdout).not.toContain(SENTINEL);
    expect(r.stderr).not.toContain(SENTINEL);
    for (const [name, body] of Object.entries(r.files)) {
      expect(body, name).not.toContain(SENTINEL);
    }
  }

  it("never appears in stdout, stderr, the record or the SARIF", async () => {
    const r = await cli([REPO, "--agent", "coder-agent"]);
    assertAbsent(r);
    expect(r.code).toBe(0);
  });

  it("never appears even when a response or a network error echoes it", async () => {
    const fx = goodFixture();
    fx.collaborators = { status: 403, body: { message: `bad credentials ${SENTINEL}` } };
    fx.extra[`/repos/${REPO}/branches/main/protection`] = { status: 500, body: { message: SENTINEL } };
    assertAbsent(await cli([REPO, "--agent", "coder-agent"], fx));
    const throwing = async () => {
      throw new Error(`connect failed with token ${SENTINEL}`);
    };
    assertAbsent(await cli([REPO], fx, { GITHUB_TOKEN: SENTINEL }, throwing));
  });

  it("is read from the variable named by --token-env", async () => {
    const f = fixtureFetch(goodFixture());
    const out = mkdtempSync(join(tmpdir(), "darz-test-"));
    let stdout = "";
    await main([REPO, "--out", out, "--token-env", "MY_TOKEN"], {
      env: { MY_TOKEN: SENTINEL, GITHUB_TOKEN: "other" },
      fetch: f.fetch,
      stdout: (s) => (stdout += s),
      stderr: () => {},
    });
    expect(f.calls[0]?.headers.authorization).toBe(`Bearer ${SENTINEL}`);
    expect(stdout).not.toContain(SENTINEL);
  });

  it("calls no host other than the API URL", async () => {
    const f = fixtureFetch(goodFixture());
    const out = mkdtempSync(join(tmpdir(), "darz-test-"));
    await main([REPO, "--out", out, "--agent", "coder-agent"], { env: {}, fetch: f.fetch, stdout: () => {}, stderr: () => {} });
    expect(f.calls.length).toBeGreaterThan(10);
    expect(f.calls.every((c) => c.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses an API URL that carries credentials", async () => {
    expect((await cli([REPO, "--api-url", "https://user:secret@api.github.com"])).code).toBe(64);
  });
});
