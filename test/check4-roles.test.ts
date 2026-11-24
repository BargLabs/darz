// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Check 4 and roles.
//
// An OrganizationAdmin bypass actor covers organisation owners, not
// every repository admin. A repository admin who is not an owner is not
// covered, so naming them under agent_role_can_bypass stated a coverage that
// does not hold. Darz now reads the organisation membership role of each
// admin user agent, when an OrganizationAdmin bypass is in effect.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import { type FakeResponse, fakeFetch } from "./helpers/fake-fetch.js";
import { FORBIDDEN, type Fixture, NOT_FOUND, OWNER, REPO, collaborator, goodFixture, ok, ruleset, toRoutes } from "./fixtures/github.js";

async function runWithCalls(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<{ a: Assessment; urls: string[] }> {
  const f = fakeFetch(toRoutes(fx));
  const a = await assess({ repo: REPO, fetch: f.fetch, agents: ["coder-agent"], now: () => new Date("2026-11-24T12:00:00Z"), ...extra });
  return { a, urls: f.calls.map((c) => c.url.replace("https://api.github.com", "")) };
}

function row(a: Assessment, id: string): CheckRow {
  const r = a.checks.find((c) => c.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}
const codes = (r: CheckRow) => r.reasons.map((x) => x.code);
const MEMBERSHIP = `/orgs/${OWNER}/memberships/coder-agent`;

function orgAdminBypass(membership?: FakeResponse): Fixture {
  const fx = goodFixture();
  fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-agent", "admin")]];
  fx.rulesets = { 42: ruleset(42, [{ actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "always" }]) };
  if (membership) fx.extra[MEMBERSHIP] = membership;
  return fx;
}

describe("an OrganizationAdmin bypass covers organisation owners only", () => {
  it("an admin agent who is an organisation owner is covered", async () => {
    const { a } = await runWithCalls(orgAdminBypass(ok({ role: "admin", state: "active", user: { login: "coder-agent" } })));
    const r = row(a, "agents_cannot_bypass");
    expect(codes(r)).toEqual(["agent_role_can_bypass", "agent_is_admin"]);
    expect(r.reasons[0]?.subjects).toEqual(["coder-agent is an organisation owner, covered by organisation admin bypass on ruleset 42"]);
    expect(r.read).toContain(`GET ${MEMBERSHIP}`);
  });

  it("an admin agent who is an organisation member but not an owner is not covered", async () => {
    const { a } = await runWithCalls(orgAdminBypass(ok({ role: "member", state: "active" })));
    const r = row(a, "agents_cannot_bypass");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["agent_is_admin"]);
    expect(r.context).toContain(
      `coder-agent is a repository admin but not an owner of organisation ${OWNER}, so the organisation admin bypass on ruleset 42 does not cover it.`,
    );
  });

  it("an invitation to be an owner that is still pending is not ownership", async () => {
    const { a } = await runWithCalls(orgAdminBypass(ok({ role: "admin", state: "pending" })));
    expect(codes(row(a, "agents_cannot_bypass"))).toEqual(["agent_is_admin"]);
  });

  const unreadable: Array<[string, FakeResponse, string]> = [
    ["404", NOT_FOUND, "not_permitted, 404"],
    ["403", FORBIDDEN, "not_permitted, 403"],
  ];
  for (const [name, res, why] of unreadable) {
    it(`a ${name} on the membership: coverage is not claimed, the row still fails on agent_is_admin, and the context says why`, async () => {
      const { a } = await runWithCalls(orgAdminBypass(res));
      const r = row(a, "agents_cannot_bypass");
      expect(r.status).toBe("fail");
      expect(codes(r)).toEqual(["agent_is_admin"]);
      const line = r.context.find((c) => c.startsWith("Whether coder-agent is an owner of organisation"));
      expect(line).toBeDefined();
      expect(line).toContain(`GET ${MEMBERSHIP} was ${why}`);
    });
  }

  it("a repository owned by a user: OrganizationAdmin covers no one and no membership is read", async () => {
    const fx = orgAdminBypass();
    fx.repo = ok({ full_name: REPO, default_branch: "main", private: true, owner: { login: OWNER, type: "User" } });
    const { a, urls } = await runWithCalls(fx);
    const r = row(a, "agents_cannot_bypass");
    expect(codes(r)).toEqual(["agent_is_admin"]);
    expect(urls.some((u) => u.startsWith("/orgs/"))).toBe(false);
    expect(r.context.some((c) => c.includes("not applicable for personal repositories"))).toBe(true);
  });

  it("no membership is read without an OrganizationAdmin bypass", async () => {
    const fx = orgAdminBypass();
    fx.rulesets = { 42: ruleset(42, []) };
    const { urls } = await runWithCalls(fx);
    expect(urls.some((u) => u.includes("/memberships/"))).toBe(false);
  });

  it("no membership is read for an agent below admin", async () => {
    const fx = orgAdminBypass();
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-agent", "write")]];
    const { a, urls } = await runWithCalls(fx);
    expect(urls.some((u) => u.includes("/memberships/"))).toBe(false);
    expect(row(a, "agents_cannot_bypass").status).toBe("pass");
  });
});

// GitHub gives repository roles to people and teams, and makes an
// organisation owner a person. An app acting with its installation token has
// only its installation's permissions, and can match only an Integration
// bypass actor. These tests pin that reading; see docs/checks.md.
describe("an app agent and role bypasses", () => {
  function appAgent(): Fixture {
    const fx = goodFixture();
    fx.collaborators = [[collaborator("alice", "admin")]];
    fx.rulesets = {
      42: ruleset(42, [
        { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
        { actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "always" },
      ]),
    };
    fx.pulls = [{ number: 6, author: "alice", files: [["README.md"]] }];
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app" }) };
    return fx;
  }

  it("an app agent that is not a collaborator is covered by neither, and no membership is read", async () => {
    const { a, urls } = await runWithCalls(appAgent(), { agents: [], agentApps: ["coder-app=555"] });
    const r = row(a, "agents_cannot_bypass");
    expect(r.status).toBe("pass");
    expect(urls.some((u) => u.includes("/memberships/"))).toBe(false);
  });

  it("an app bot account that does appear as a collaborator is treated as holding its permission", async () => {
    const fx = appAgent();
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-app[bot]", "write", "Bot")]];
    const r = row((await runWithCalls(fx, { agents: [], agentApps: ["coder-app=555"] })).a, "agents_cannot_bypass");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["bypass_role_unknown"]);
  });

  it("an app bot account listed as an admin collaborator is never an organisation owner, but fails as an admin", async () => {
    const fx = appAgent();
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-app[bot]", "admin", "Bot")]];
    const { a, urls } = await runWithCalls(fx, { agents: [], agentApps: ["coder-app=555"] });
    expect(codes(row(a, "agents_cannot_bypass"))).toEqual(["agent_is_admin"]);
    expect(urls.some((u) => u.includes("/memberships/"))).toBe(false);
  });
});
