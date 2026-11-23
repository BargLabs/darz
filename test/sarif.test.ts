// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { buildSarif, webUrlFor } from "../src/sarif.js";
import { FORBIDDEN, NOT_FOUND, REPO, fixtureFetch, goodFixture, pullRequestRule, tree } from "./fixtures/github.js";
import { sarifErrors } from "./helpers/schemas.js";

const now = () => new Date("2026-11-20T12:00:00Z");

async function sarifFor(fx: ReturnType<typeof goodFixture>, agents = ["coder-agent"]) {
  const a = await assess({ repo: REPO, fetch: fixtureFetch(fx).fetch, agents, now });
  return { a, sarif: buildSarif(a) as any };
}

describe("SARIF 2.1.0", () => {
  it("a passing run validates and has no results", async () => {
    const { sarif } = await sarifFor(goodFixture());
    expect(sarifErrors(sarif)).toEqual([]);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results).toEqual([]);
  });

  it("gives one result per fail or unverifiable row: error for fail, warning for unverifiable", async () => {
    const fx = goodFixture();
    fx.rules = [[pullRequestRule({ required_approving_review_count: 0 })]];
    fx.collaborators = FORBIDDEN;
    const { a, sarif } = await sarifFor(fx);
    expect(sarifErrors(sarif)).toEqual([]);
    const expected = a.checks
      .filter((c) => c.status === "fail" || c.status === "unverifiable")
      .map((c) => [`darz/${c.id}`, c.status === "fail" ? "error" : "warning"]);
    expect(expected.length).toBeGreaterThan(1);
    expect(sarif.runs[0].results.map((r: any) => [r.ruleId, r.level])).toEqual(expected);
  });

  it("every rule has help text and an id darz/<check id>", async () => {
    const { sarif } = await sarifFor(goodFixture());
    const rules = sarif.runs[0].tool.driver.rules;
    expect(rules.map((r: any) => r.id)).toEqual([
      "darz/gate_files_owned",
      "darz/human_review_required",
      "darz/writer_not_approver",
      "darz/agents_cannot_bypass",
      "darz/required_checks_fail_closed",
      "darz/agent_merges_touching_gates",
    ]);
    for (const r of rules) expect(r.help.text.length).toBeGreaterThan(20);
  });

  it("locates a setting at .github/CODEOWNERS when it exists, else README.md", async () => {
    const fx = goodFixture();
    fx.rules = [[pullRequestRule({ required_approving_review_count: 0 })]];
    const { sarif } = await sarifFor(fx);
    const r = sarif.runs[0].results.find((x: any) => x.ruleId === "darz/human_review_required");
    expect(r.locations[0].physicalLocation.artifactLocation.uri).toBe(".github/CODEOWNERS");

    const fx2 = goodFixture();
    fx2.rules = [[pullRequestRule({ required_approving_review_count: 0 })]];
    fx2.codeowners = {};
    fx2.tree = tree(["README.md", "src/a.ts"]);
    const { sarif: s2 } = await sarifFor(fx2);
    const r2 = s2.runs[0].results.find((x: any) => x.ruleId === "darz/human_review_required");
    expect(r2.locations[0].physicalLocation.artifactLocation.uri).toBe("README.md");
    expect(sarifErrors(s2)).toEqual([]);
  });

  it("locates a CODEOWNERS finding at the CODEOWNERS file in use", async () => {
    const fx = goodFixture();
    fx.codeowners = { CODEOWNERS: { status: 200, body: { type: "file", encoding: "base64", content: Buffer.from("/src/ @alice\n").toString("base64") } } };
    fx.tree = tree(["CODEOWNERS", ".github/workflows/ci.yml"]);
    const { sarif } = await sarifFor(fx);
    const r = sarif.runs[0].results.find((x: any) => x.ruleId === "darz/gate_files_owned");
    expect(r.level).toBe("error");
    expect(r.locations[0].physicalLocation.artifactLocation.uri).toBe("CODEOWNERS");
  });

  it("an unreadable repository still gives valid SARIF", async () => {
    const fx = goodFixture();
    fx.repo = NOT_FOUND;
    const { sarif } = await sarifFor(fx);
    expect(sarifErrors(sarif)).toEqual([]);
    expect(sarif.runs[0].results).toHaveLength(6);
  });
});

describe("the vendored SARIF schema is a real oracle", () => {
  it("rejects a document without runs and a result with a bad level", () => {
    expect(sarifErrors({ version: "2.1.0" })).not.toEqual([]);
    expect(
      sarifErrors({
        version: "2.1.0",
        runs: [{ tool: { driver: { name: "darz" } }, results: [{ message: { text: "x" }, level: "fatal" }] }],
      }),
    ).not.toEqual([]);
  });
});

describe("SARIF provenance and links", () => {
  it("maps each kind of API URL to its web URL, and anything else to null", () => {
    expect(webUrlFor("https://api.github.com")).toBe("https://github.com");
    expect(webUrlFor("https://ghe.corp.example/api/v3")).toBe("https://ghe.corp.example");
    expect(webUrlFor("https://ghe.corp.example:8443/api/v3/")).toBe("https://ghe.corp.example:8443");
    expect(webUrlFor("https://api.octocorp.ghe.com")).toBe("https://octocorp.ghe.com");
    expect(webUrlFor("https://proxy.example/github")).toBeNull();
  });

  it("names the repository on the instance that was read", async () => {
    const { a } = await sarifFor(goodFixture());
    const ghes = buildSarif({ ...a, apiUrl: "https://ghe.corp.example/api/v3" }) as any;
    expect(ghes.runs[0].versionControlProvenance[0].repositoryUri).toBe(`https://ghe.corp.example/${REPO}`);
    const dotcom = buildSarif(a) as any;
    expect(dotcom.runs[0].versionControlProvenance[0].repositoryUri).toBe(`https://github.com/${REPO}`);
  });

  it("leaves provenance out rather than guess for an unrecognised API URL", async () => {
    const { a } = await sarifFor(goodFixture());
    const sarif = buildSarif({ ...a, apiUrl: "https://proxy.example/github" }) as any;
    expect(sarif.runs[0].versionControlProvenance).toBeUndefined();
    expect(sarifErrors(sarif)).toEqual([]);
  });

  it("links each rule to its section of docs/checks.md by GitHub's heading anchor", async () => {
    const { sarif } = await sarifFor(goodFixture());
    const uris = sarif.runs[0].tool.driver.rules.map((r: any) => r.helpUri.split("#")[1]);
    expect(uris).toEqual([
      "1-gate_files_owned",
      "2-human_review_required",
      "3-writer_not_approver",
      "4-agents_cannot_bypass",
      "5-required_checks_fail_closed",
      "6-agent_merges_touching_gates",
    ]);
  });
});
