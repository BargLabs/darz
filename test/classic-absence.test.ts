// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Issue 18: GitHub answers 404 on classic branch protection both when there is
// none and when the token may not read it. A classic token says what it may do
// in the x-oauth-scopes response header: with the repo scope and an admin user,
// it can read classic protection, so a 404 then proves there is none. Without
// that proof (fine-grained and app tokens send no scopes header) a 404 stays
// unreadable.

import { describe, expect, it } from "vitest";
import { type Assessment, assess } from "../src/assess.js";
import { buildRecord, serializeRecord } from "../src/record.js";
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
import { recordErrors } from "./helpers/schemas.js";

function repoWith(admin: boolean, scopes: string | null) {
  const body = {
    full_name: REPO,
    default_branch: "main",
    private: true,
    owner: { login: OWNER, type: "Organization" },
    permissions: { admin, maintain: admin, push: true, triage: true, pull: true },
  };
  return scopes === null ? ok(body) : ok(body, { "x-oauth-scopes": scopes });
}

async function run(fx: Fixture): Promise<Assessment> {
  return assess({ repo: REPO, fetch: fixtureFetch(fx).fetch, agents: ["coder-agent"], now: () => new Date("2026-11-22T12:00:00Z") });
}

const row = (a: Assessment, id: string) => a.checks.find((c) => c.id === id);

function rulesetsOnly(scopes: string | null, admin = true): Fixture {
  const fx = goodFixture();
  fx.repo = repoWith(admin, scopes);
  fx.classic = NOT_FOUND;
  return fx;
}

describe("classic protection absence is proven only by the token's own scopes (issue 18)", () => {
  it("an admin user's classic token with the repo scope that gets a 404: there is no classic protection", async () => {
    const a = await run(rulesetsOnly("repo, workflow"));
    expect(a.classicProtection).toEqual({ state: "absent", basis: "admin_token_with_repo_scope" });
    expect(row(a, "agents_cannot_bypass")?.status).toBe("pass");
    expect(row(a, "required_checks_fail_closed")?.status).toBe("pass");
  });

  it("the scope is matched as a whole word, not a prefix", async () => {
    const a = await run(rulesetsOnly("public_repo, workflow"));
    expect(a.classicProtection.state).toBe("unreadable");
  });

  it("a token with no scopes header (fine-grained or app) that gets a 404: still unreadable", async () => {
    const a = await run(rulesetsOnly(null));
    expect(a.classicProtection).toEqual({ state: "unreadable", basis: "not_permitted_or_error" });
    expect(row(a, "agents_cannot_bypass")?.status).toBe("unverifiable");
  });

  it("a user who is not an admin, even with the repo scope: still unreadable", async () => {
    const a = await run(rulesetsOnly("repo", false));
    expect(a.classicProtection.state).toBe("unreadable");
  });

  it("a 403 is never taken as absence, whatever the scopes", async () => {
    const fx = rulesetsOnly("repo");
    fx.classic = FORBIDDEN;
    expect((await run(fx)).classicProtection.state).toBe("unreadable");
  });

  it("with absence proven and no required check in the rules, check 5 fails instead of being unverifiable", async () => {
    const fx = rulesetsOnly("repo");
    fx.rules = [[pullRequestRule(GOOD_PR_PARAMS)]];
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r?.status).toBe("fail");
    expect(r?.reasons.map((x) => x.code)).toEqual(["no_required_checks"]);
  });

  it("with absence proven, an unpinned required check in the rules fails", async () => {
    const fx = rulesetsOnly("repo");
    fx.rules = [[pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test"], true, 42, null)]];
    expect(row(await run(fx), "required_checks_fail_closed")?.reasons.map((x) => x.code)).toEqual(["required_check_unpinned"]);
  });

  it("the record names the endpoint and the basis, and validates against the schema", async () => {
    const a = await run(rulesetsOnly("repo"));
    const rec = JSON.parse(serializeRecord(buildRecord(a, { agents: ["coder-agent"], agentApps: [], gates: [], merges: 50 })).bytes.toString("utf8"));
    expect(recordErrors(rec)).toEqual([]);
    expect(rec.classicProtection).toEqual({ state: "absent", basis: "admin_token_with_repo_scope" });
    expect(row(a, "agents_cannot_bypass")?.read).toContain(`GET /repos/${REPO}/branches/main/protection`);
  });
});
