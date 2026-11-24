// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// One agent app slug declared twice with different ids kept the
// first id with no note. Which app is the agent is then unknown, so the rows
// that depend on it are unverifiable.
//
// A declared slug=id whose GET /apps/{slug} lookup failed was used
// with no note. The declared id still decides the rows (a private App may not
// be visible to the token), and a context line says it was not
// confirmed.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import {
  FORBIDDEN,
  type Fixture,
  GOOD_PR_PARAMS,
  NOT_FOUND,
  REPO,
  fileBody,
  fixtureFetch,
  goodFixture,
  ok,
  pullRequestRule,
  statusChecksRule,
} from "./fixtures/github.js";

async function run(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<Assessment> {
  return assess({ repo: REPO, fetch: fixtureFetch(fx).fetch, agents: [], now: () => new Date("2026-11-24T12:00:00Z"), ...extra });
}

function row(a: Assessment, id: string): CheckRow {
  const r = a.checks.find((c) => c.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}
const codes = (r: CheckRow) => r.reasons.map((x) => x.code);

function withConfig(config: unknown): Fixture {
  const fx = goodFixture();
  fx.pulls = [{ number: 6, author: "alice", files: [["README.md"]] }];
  fx.config = ok(fileBody(".github/darz.json", JSON.stringify(config)));
  fx.apps = { "coder-app": NOT_FOUND };
  return fx;
}

function pinned(fx: Fixture, appId: number): Fixture {
  fx.rules = [[pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test"], true, 42, appId)]];
  return fx;
}

const AGENT_ROWS = ["writer_not_approver", "agents_cannot_bypass", "agent_merges_touching_gates"];

describe("one agent app slug declared with two different ids", () => {
  const conflicting: Array<[string, unknown, string[]]> = [
    ["twice in .github/darz.json", { agentApps: [{ slug: "coder-app", id: 555 }, { slug: "coder-app", id: 777 }] }, []],
    ["once as a flag and once in .github/darz.json", { agentApps: [{ slug: "coder-app", id: 777 }] }, ["coder-app=555"]],
    ["twice as a flag", {}, ["coder-app=555", "coder-app=777"]],
    ["with different case and a [bot] suffix", { agentApps: [{ slug: "Coder-App[bot]", id: 777 }] }, ["coder-app=555"]],
  ];
  for (const [name, config, flags] of conflicting) {
    it(`${name}: checks 3, 4 and 6 are unverifiable with agent_app_ids_conflict`, async () => {
      const a = await run(withConfig(config), { agentApps: flags });
      for (const id of AGENT_ROWS) {
        expect(row(a, id).status).toBe("unverifiable");
        expect(codes(row(a, id))).toContain("agent_app_ids_conflict");
      }
      expect(row(a, "writer_not_approver").reasons.find((r) => r.code === "agent_app_ids_conflict")?.subjects).toEqual([
        "coder-app (declared 555 and 777)",
      ]);
    });
  }

  it("check 5 with a pinned required check is unverifiable too", async () => {
    const fx = pinned(withConfig({ agentApps: [{ slug: "coder-app", id: 777 }] }), 999);
    const r = row(await run(fx, { agentApps: ["coder-app=555"] }), "required_checks_fail_closed");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["agent_app_ids_conflict"]);
  });

  it("the same slug declared twice with the same id is no conflict", async () => {
    const a = await run(withConfig({ agentApps: [{ slug: "coder-app", id: 555 }] }), { agentApps: ["coder-app=555"] });
    expect(row(a, "writer_not_approver").status).toBe("pass");
    expect(codes(row(a, "agents_cannot_bypass"))).not.toContain("agent_app_ids_conflict");
  });

  it("a slug declared once without an id and once with one is no conflict", async () => {
    const a = await run(withConfig({ agentApps: ["coder-app"] }), { agentApps: ["coder-app=555"] });
    expect(a.identities).toEqual([
      { kind: "app", slug: "coder-app", appId: 555, source: "declared", foundIn: ["config", "flag"] },
    ]);
    expect(row(a, "writer_not_approver").status).toBe("pass");
  });
});

describe("a declared app id whose lookup failed is marked unconfirmed", () => {
  const failed: Array<[string, Fixture["apps"][string], string]> = [
    ["404", NOT_FOUND, "404"],
    ["403", FORBIDDEN, "403"],
  ];
  for (const [name, response, status] of failed) {
    it(`a ${name} lookup: the declared id still decides, and checks 3, 4 and 6 say it was not confirmed`, async () => {
      const fx = withConfig({ agentApps: [{ slug: "coder-app", id: 555 }] });
      fx.apps = { "coder-app": response };
      const a = await run(fx);
      expect(row(a, "writer_not_approver").status).toBe("pass");
      for (const id of AGENT_ROWS) {
        const r = row(a, id);
        const line = r.context.find((c) => c.startsWith("Agent app coder-app: id 555 is as declared;"));
        expect(line, id).toBeDefined();
        expect(line).toContain("GET /apps/coder-app did not confirm it");
        expect(line).toContain(status);
        expect(r.read).toContain("GET /apps/coder-app");
      }
    });
  }

  it("check 5 says so too when a required check is pinned to the declared id", async () => {
    const fx = pinned(withConfig({ agentApps: [{ slug: "coder-app", id: 555 }] }), 555);
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["required_check_pinned_to_agent_app"]);
    expect(r.context.some((c) => c.startsWith("Agent app coder-app: id 555 is as declared;"))).toBe(true);
  });

  it("a lookup that confirms the declared id adds no such line", async () => {
    const fx = withConfig({ agentApps: [{ slug: "coder-app", id: 555 }] });
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app" }) };
    const a = await run(fx);
    for (const id of AGENT_ROWS) expect(row(a, id).context.some((c) => c.includes("is as declared"))).toBe(false);
  });

  it("an id taken from a successful lookup, not declared, adds no such line", async () => {
    const fx = withConfig({ agentApps: ["coder-app"] });
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app" }) };
    const a = await run(fx);
    for (const id of AGENT_ROWS) expect(row(a, id).context.some((c) => c.includes("is as declared"))).toBe(false);
  });
});

// The mirror of the first case: two different declared slugs with one id were
// merged into one identity that kept the first slug, with no note. A misspelt
// slug then hid, and when the misspelt one came first, the agent's real bot
// login (`coder-app[bot]`) matched no identity at all.
describe("two declared agent app slugs with one id", () => {
  const sharing: Array<[string, unknown, string[]]> = [
    ["the right slug first, both as flags", {}, ["coder-app=555", "codr-app=555"]],
    ["the misspelt slug first, both as flags", {}, ["codr-app=555", "coder-app=555"]],
    ["one in .github/darz.json and one as a flag", { agentApps: [{ slug: "codr-app", id: 555 }] }, ["coder-app=555"]],
    ["both in .github/darz.json", { agentApps: [{ slug: "coder-app", id: 555 }, { slug: "codr-app", id: 555 }] }, []],
  ];
  for (const [name, config, flags] of sharing) {
    it(`${name}: checks 3, 4 and 6 are unverifiable with agent_app_slugs_share_id`, async () => {
      const a = await run(withConfig(config), { agentApps: flags });
      for (const id of AGENT_ROWS) {
        expect(row(a, id).status, id).toBe("unverifiable");
        expect(codes(row(a, id))).toContain("agent_app_slugs_share_id");
      }
      expect(row(a, "agents_cannot_bypass").reasons.find((r) => r.code === "agent_app_slugs_share_id")?.subjects).toEqual([
        "coder-app and codr-app (id 555)",
      ]);
    });
  }

  it("a declared slug whose lookup gives the id another declared slug names counts too", async () => {
    const fx = withConfig({ agentApps: ["coder-app"] });
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app" }) };
    const r = row(await run(fx, { agentApps: ["codr-app=555"] }), "writer_not_approver");
    expect(r.status).toBe("unverifiable");
    expect(r.reasons.find((x) => x.code === "agent_app_slugs_share_id")?.subjects).toEqual(["coder-app and codr-app (id 555)"]);
  });

  it("the misspelt slug first no longer hides the agent's merged pull request", async () => {
    const fx = withConfig({});
    fx.pulls = [
      { number: 8, author: "coder-app[bot]", files: [[".github/workflows/ci.yml"]], reviews: [{ user: "alice", state: "APPROVED" }] },
    ];
    const r = row(await run(fx, { agentApps: ["codr-app=555", "coder-app=555"] }), "agent_merges_touching_gates");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toContain("agent_app_slugs_share_id");
  });

  it("check 5 with a required check pinned to an app is unverifiable too", async () => {
    const fx = pinned(withConfig({}), 999);
    const r = row(await run(fx, { agentApps: ["coder-app=555", "codr-app=555"] }), "required_checks_fail_closed");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["agent_app_slugs_share_id"]);
  });

  it("a declared slug and a detected app with the same id are no conflict", async () => {
    const fx = withConfig({ agentApps: [{ slug: "coder-app", id: 555 }] });
    fx.pulls = [{ number: 6, author: "coder-app-old[bot]", files: [["README.md"]] }];
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app" }), "coder-app-old": ok({ id: 555, slug: "coder-app" }) };
    const a = await run(fx);
    for (const id of AGENT_ROWS) expect(codes(row(a, id))).not.toContain("agent_app_slugs_share_id");
  });

  it("the same slug in different case is one slug, not two", async () => {
    const a = await run(withConfig({ agentApps: [{ slug: "Coder-App[bot]", id: 555 }] }), { agentApps: ["coder-app=555"] });
    expect(row(a, "writer_not_approver").status).toBe("pass");
  });
});
