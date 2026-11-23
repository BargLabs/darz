// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Issue 30: a private agent App's slug may not resolve with the token Darz
// reads with (the workflow token could not read GET /apps/{slug} for a
// private App). An app can be declared with its id, so no lookup is needed.
// When the lookup does resolve and disagrees with the declared id, the rows
// that depend on the agent are unverifiable.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import { REPO, type Fixture, NOT_FOUND, fileBody, fixtureFetch, goodFixture, ok, ruleset } from "./fixtures/github.js";

async function run(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<Assessment> {
  return assess({ repo: REPO, fetch: fixtureFetch(fx).fetch, agents: [], now: () => new Date("2026-11-22T12:00:00Z"), ...extra });
}
const row = (a: Assessment, id: string) => a.checks.find((c) => c.id === id);
const codes = (a: Assessment, id: string) => row(a, id)?.reasons.map((r) => r.code) ?? [];

function withConfig(config: unknown): Fixture {
  const fx = goodFixture();
  fx.pulls = [{ number: 6, author: "alice", files: [["README.md"]] }];
  fx.config = ok(fileBody(".github/darz.json", JSON.stringify(config)));
  fx.apps = { "coder-app": NOT_FOUND };
  return fx;
}

describe("declaring an agent app with its id (issue 30)", () => {
  it("in .github/darz.json, the app needs no lookup: no agent_app_unresolved", async () => {
    const a = await run(withConfig({ agentApps: [{ slug: "coder-app", id: 555 }] }));
    expect(a.identities).toEqual([{ kind: "app", slug: "coder-app", appId: 555, source: "declared", foundIn: ["config"] }]);
    for (const id of ["writer_not_approver", "agents_cannot_bypass", "agent_merges_touching_gates"]) {
      expect(codes(a, id)).not.toContain("agent_app_unresolved");
    }
    expect(row(a, "writer_not_approver")?.status).toBe("pass");
  });

  it("the declared id matches an Integration bypass actor", async () => {
    const fx = withConfig({ agentApps: [{ slug: "coder-app", id: 555 }] });
    fx.rulesets = { 42: ruleset(42, [{ actor_id: 555, actor_type: "Integration", bypass_mode: "always" }]) };
    const a = await run(fx);
    expect(row(a, "agents_cannot_bypass")?.reasons[0]?.subjects).toEqual(["app coder-app (id 555) on ruleset 42"]);
    expect(a.identities).toHaveLength(1);
  });

  it("on the command line as slug=id", async () => {
    const fx = withConfig({});
    const a = await run(fx, { agentApps: ["coder-app=555"] });
    expect(a.identities).toEqual([{ kind: "app", slug: "coder-app", appId: 555, source: "declared", foundIn: ["flag"] }]);
    expect(codes(a, "writer_not_approver")).not.toContain("agent_app_unresolved");
  });

  it("a lookup that agrees with the declared id is fine", async () => {
    const fx = withConfig({ agentApps: [{ slug: "coder-app", id: 555 }] });
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app" }) };
    expect(row(await run(fx), "writer_not_approver")?.status).toBe("pass");
  });

  it("a lookup that disagrees with the declared id makes the agent's rows unverifiable", async () => {
    const fx = withConfig({ agentApps: [{ slug: "coder-app", id: 555 }] });
    fx.apps = { "coder-app": ok({ id: 777, slug: "coder-app" }) };
    const a = await run(fx);
    for (const id of ["writer_not_approver", "agents_cannot_bypass", "agent_merges_touching_gates"]) {
      expect(row(a, id)?.status).toBe("unverifiable");
      expect(codes(a, id)).toContain("agent_app_id_mismatch");
    }
    expect(row(a, "writer_not_approver")?.reasons.find((r) => r.code === "agent_app_id_mismatch")?.subjects).toEqual([
      "coder-app (declared 555, GitHub says 777)",
    ]);
  });

  it("a declared app without an id whose lookup fails is still agent_app_unresolved", async () => {
    const a = await run(withConfig({ agentApps: ["coder-app"] }));
    expect(codes(a, "writer_not_approver")).toEqual(["agent_app_unresolved"]);
  });

  const invalid: Array<[string, unknown]> = [
    ["an id that is not a positive whole number", { agentApps: [{ slug: "coder-app", id: "555" }] }],
    ["an object with no slug", { agentApps: [{ id: 555 }] }],
    ["an object with an unknown key", { agentApps: [{ slug: "coder-app", id: 555, name: "x" }] }],
  ];
  for (const [name, config] of invalid) {
    it(`a config entry with ${name} makes the config invalid`, async () => {
      expect(codes(await run(withConfig(config)), "writer_not_approver")).toContain("config_invalid");
    });
  }

  it("a malformed --agent-app slug=id is a usage error, not a silent declaration", async () => {
    await expect(run(withConfig({}), { agentApps: ["coder-app=abc"] })).rejects.toThrow(/agent-app/);
  });
});
