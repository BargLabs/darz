// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import {
  FORBIDDEN,
  type Fixture,
  GOOD_PR_PARAMS,
  NOT_FOUND,
  PULLS_PATH,
  REPO,
  SERVER_ERROR,
  SHA,
  classicProtection,
  collaborator,
  fileBody,
  fixtureFetch,
  goodFixture,
  ok,
  pullRequestRule,
  ruleset,
  statusChecksRule,
  tree,
} from "./fixtures/github.js";

async function run(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<Assessment> {
  return assess({
    repo: REPO,
    fetch: fixtureFetch(fx).fetch,
    agents: ["coder-agent"],
    now: () => new Date("2026-11-20T12:00:00Z"),
    ...extra,
  });
}

function row(a: Assessment, id: string): CheckRow {
  const r = a.checks.find((c) => c.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

function codes(r: CheckRow): string[] {
  return r.reasons.map((x) => x.code);
}

function withRules(fx: Fixture, rules: unknown[]): Fixture {
  fx.rules = [rules];
  return fx;
}

describe("the good fixture", () => {
  it("passes checks 1 to 5 and gives checks 6 and 7 as context", async () => {
    const a = await run(goodFixture());
    expect(a.checks.map((c) => [c.id, c.status])).toEqual([
      ["gate_files_owned", "pass"],
      ["human_review_required", "pass"],
      ["writer_not_approver", "pass"],
      ["agents_cannot_bypass", "pass"],
      ["required_checks_fail_closed", "pass"],
      ["agent_merges_touching_gates", "context"],
      ["lessons_hold", "context"],
    ]);
    expect(a.commitSha).toBe(SHA);
    expect(a.defaultBranch).toBe("main");
  });

  it("each row names the endpoints or files it read", async () => {
    const a = await run(goodFixture());
    expect(row(a, "gate_files_owned").read).toEqual(
      expect.arrayContaining([`GET /repos/${REPO}/git/trees/${SHA}?recursive=1`, ".github/CODEOWNERS"]),
    );
    expect(row(a, "human_review_required").read).toContain(`GET /repos/${REPO}/rules/branches/main?per_page=100`);
  });
});

describe("check 1: gate_files_owned", () => {
  it("fails with gate_files_unowned and lists the files", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "/src/ @alice\n")) };
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("fail");
    expect(codes(r)).toContain("gate_files_unowned");
    expect(r.reasons.find((x) => x.code === "gate_files_unowned")?.subjects).toEqual([
      ".github/CODEOWNERS",
      ".github/workflows/ci.yml",
      "vitest.config.ts",
    ]);
  });

  it("fails with code_owner_review_not_required", async () => {
    const fx = withRules(goodFixture(), [
      pullRequestRule({ ...GOOD_PR_PARAMS, require_code_owner_review: false }),
      statusChecksRule(["test"]),
    ]);
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["code_owner_review_not_required"]);
  });

  it("with no CODEOWNERS file, the gate files are unowned", async () => {
    const fx = goodFixture();
    fx.codeowners = {};
    fx.tree = tree([".github/workflows/ci.yml", "README.md"]);
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("fail");
    expect(r.reasons.find((x) => x.code === "gate_files_unowned")?.subjects).toEqual([".github/workflows/ci.yml"]);
  });

  it("uses .github/CODEOWNERS over a root CODEOWNERS", async () => {
    const fx = goodFixture();
    fx.codeowners = {
      ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", GOOD_CODEOWNERS_OWNED)),
      CODEOWNERS: ok(fileBody("CODEOWNERS", "/src/ @alice\n")),
    };
    fx.tree = tree([".github/CODEOWNERS", "CODEOWNERS", ".github/workflows/ci.yml"]);
    const a = await run(fx);
    expect(row(a, "gate_files_owned").status).toBe("pass");
    expect(a.codeownersPath).toBe(".github/CODEOWNERS");
  });

  it("a tree with truncated: true is unverifiable, reason tree_truncated", async () => {
    const fx = goodFixture();
    fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml"], true);
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["tree_truncated"]);
  });

  it("an unreadable tree is unverifiable", async () => {
    const fx = goodFixture();
    fx.tree = SERVER_ERROR;
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["tree_unreadable"]);
  });

  it("a 403 on the rules endpoint is unverifiable, not fail", async () => {
    const fx = goodFixture();
    fx.rules = FORBIDDEN;
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toContain("rules_unreadable");
  });

  it("unreadable codeowners/errors is unverifiable", async () => {
    const fx = goodFixture();
    fx.codeownersErrors = FORBIDDEN;
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["codeowners_errors_unreadable"]);
  });

  it("an unreadable CODEOWNERS file is unverifiable", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": FORBIDDEN };
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["codeowners_unreadable"]);
  });

  it("a line GitHub reports as an error does not count as an owner, and is reported", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "/src/ @alice\n/.github/ @ghost\n/vitest.config.ts @alice\n")) };
    fx.codeownersErrors = ok({
      errors: [{ line: 2, column: 11, kind: "Unknown owner", source: "/.github/ @ghost", path: ".github/CODEOWNERS", message: "" }],
    });
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("fail");
    expect(r.reasons.find((x) => x.code === "gate_files_unowned")?.subjects).toEqual([
      ".github/CODEOWNERS",
      ".github/workflows/ci.yml",
    ]);
    expect(r.details?.ignoredCodeownersLines).toEqual([{ line: 2, source: "/.github/ @ghost", kind: "Unknown owner" }]);
  });

  it("an errored line over an earlier owner is unverifiable, never pass", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @alice\n/.github/ @ghost\n")) };
    fx.codeownersErrors = ok({ errors: [{ line: 2, kind: "Unknown owner", source: "/.github/ @ghost", path: ".github/CODEOWNERS" }] });
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["codeowners_error_ambiguous"]);
  });

  it("reports team owners as written and notes their members were not read", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @acme/gatekeepers\n")) };
    const r = row(await run(fx), "gate_files_owned");
    expect(r.status).toBe("pass");
    expect(r.context.join(" ")).toMatch(/@acme\/gatekeepers.*members were not read/);
  });

  it("--gate adds a pattern", async () => {
    const fx = goodFixture();
    fx.tree = tree([...[".github/CODEOWNERS", ".github/workflows/ci.yml", "vitest.config.ts"], "Makefile"]);
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "/.github/ @alice\n/vitest.config.ts @alice\n")) };
    const r = row(await run(fx, { gates: ["Makefile"] }), "gate_files_owned");
    expect(r.status).toBe("fail");
    expect(r.reasons[0]?.subjects).toEqual(["Makefile"]);
  });
});

const GOOD_CODEOWNERS_OWNED = "* @alice\n";

describe("check 2: human_review_required", () => {
  const missing: Array<[string, Record<string, unknown>, string]> = [
    ["no approving review", { required_approving_review_count: 0 }, "approving_review_not_required"],
    ["stale approvals kept", { dismiss_stale_reviews_on_push: false }, "stale_reviews_not_dismissed"],
    ["last push approval off", { require_last_push_approval: false }, "last_push_approval_not_required"],
  ];
  for (const [name, change, reason] of missing) {
    it(`fails naming ${reason} when ${name}`, async () => {
      const fx = withRules(goodFixture(), [pullRequestRule({ ...GOOD_PR_PARAMS, ...change }), statusChecksRule(["test"])]);
      const r = row(await run(fx), "human_review_required");
      expect(r.status).toBe("fail");
      expect(codes(r)).toEqual([reason]);
    });
  }

  it("names each missing setting", async () => {
    const fx = withRules(goodFixture(), [
      pullRequestRule({ ...GOOD_PR_PARAMS, dismiss_stale_reviews_on_push: false, require_last_push_approval: false }),
    ]);
    const r = row(await run(fx), "human_review_required");
    expect(codes(r)).toEqual(["stale_reviews_not_dismissed", "last_push_approval_not_required"]);
  });

  it("fails with no_pull_request_rule", async () => {
    const fx = withRules(goodFixture(), [statusChecksRule(["test"])]);
    const r = row(await run(fx), "human_review_required");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["no_pull_request_rule"]);
  });

  it("an unprotected branch fails with no_pull_request_rule without reading classic protection", async () => {
    const fx = withRules(goodFixture(), []);
    fx.branch = ok({ name: "main", commit: { sha: SHA }, protected: false });
    fx.classic = FORBIDDEN;
    const a = await run(fx);
    expect(codes(row(a, "human_review_required"))).toEqual(["no_pull_request_rule"]);
    expect(a.reads.some((x) => x.endpoint.endsWith("/branches/main/protection"))).toBe(false);
  });

  it("passes from classic protection alone", async () => {
    const fx = withRules(goodFixture(), []);
    fx.classic = classicProtection({ reviews: {}, contexts: ["test"] });
    expect(row(await run(fx), "human_review_required").status).toBe("pass");
  });

  it("combines rules and classic protection, since GitHub enforces both", async () => {
    const fx = withRules(goodFixture(), [
      pullRequestRule({ ...GOOD_PR_PARAMS, require_last_push_approval: false }),
      statusChecksRule(["test"]),
    ]);
    fx.classic = classicProtection({ reviews: { lastPush: true, count: 0, dismissStale: false } });
    expect(row(await run(fx), "human_review_required").status).toBe("pass");
  });

  it("protected, no rules, classic unreadable: unverifiable, classic_protection_unreadable", async () => {
    const fx = withRules(goodFixture(), []);
    fx.repo = ok({ full_name: REPO, default_branch: "main", permissions: { admin: false, push: true, pull: true } });
    fx.classic = NOT_FOUND;
    const r = row(await run(fx), "human_review_required");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["classic_protection_unreadable"]);
  });

  it("a 403 on the rules endpoint is unverifiable", async () => {
    const fx = goodFixture();
    fx.rules = FORBIDDEN;
    const r = row(await run(fx), "human_review_required");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toContain("rules_unreadable");
  });

  it("a field missing from a read response is unverifiable, never fail", async () => {
    const { require_last_push_approval: _drop, ...params } = GOOD_PR_PARAMS;
    const fx = withRules(goodFixture(), [pullRequestRule(params), statusChecksRule(["test"])]);
    const r = row(await run(fx), "human_review_required");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["field_missing"]);
    expect(r.reasons[0]?.subjects).toEqual(["rules.pull_request.require_last_push_approval"]);
  });
});

describe("check 3: writer_not_approver", () => {
  it("fails with agent_is_code_owner, naming the identity and files", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @alice\n/.github/workflows/ @coder-agent\n")) };
    const r = row(await run(fx), "writer_not_approver");
    expect(r.status).toBe("fail");
    expect(r.reasons).toEqual([
      expect.objectContaining({
        code: "agent_is_code_owner",
        // The probe path stands for a new workflow, which the agent would own too.
        subjects: ["coder-agent: .github/workflows/ci.yml, .github/workflows/darz-probe-new-workflow.yaml, .github/workflows/darz-probe-new-workflow.yml"],
      }),
    ]);
  });

  it("matches a code owner by login case-insensitively", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @alice @Coder-Agent\n")) };
    expect(row(await run(fx), "writer_not_approver").status).toBe("fail");
  });

  it("fails with last_push_approval_not_required", async () => {
    const fx = withRules(goodFixture(), [
      pullRequestRule({ ...GOOD_PR_PARAMS, require_last_push_approval: false }),
      statusChecksRule(["test"]),
    ]);
    const r = row(await run(fx), "writer_not_approver");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["last_push_approval_not_required"]);
  });

  it("records that GitHub never counts a pull request author's own approval, as context", async () => {
    const r = row(await run(goodFixture()), "writer_not_approver");
    expect(r.context.join(" ")).toMatch(/author's own approval/);
  });

  it("a 403 on the rules endpoint is unverifiable", async () => {
    const fx = goodFixture();
    fx.rules = FORBIDDEN;
    expect(row(await run(fx), "writer_not_approver").status).toBe("unverifiable");
  });

  it("a team owner of a gate file with a declared user agent is unverifiable", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @acme/gatekeepers\n")) };
    const r = row(await run(fx), "writer_not_approver");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["unresolved_owners"]);
  });
});

describe("no agent identities: checks 3, 4 and 6 never pass on an empty set", () => {
  it("are unverifiable with reason no_agent_identities", async () => {
    const fx = goodFixture();
    fx.pulls = [{ number: 6, author: "alice", files: [["README.md"]] }];
    const a = await run(fx, { agents: [] });
    expect(a.identities).toEqual([]);
    for (const id of ["writer_not_approver", "agents_cannot_bypass", "agent_merges_touching_gates"]) {
      const r = row(a, id);
      expect(r.status).toBe("unverifiable");
      expect(codes(r)).toEqual(["no_agent_identities"]);
    }
  });
});

describe("check 4: agents_cannot_bypass", () => {
  it("a ruleset response without bypass_actors is unverifiable, not fail and not pass", async () => {
    const fx = goodFixture();
    fx.rulesets = { 42: ruleset(42, undefined) };
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["bypass_list_unreadable"]);
  });

  it("an unreadable ruleset is unverifiable", async () => {
    const fx = goodFixture();
    fx.rulesets = { 42: FORBIDDEN };
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["ruleset_unreadable"]);
  });

  it("reads organisation rulesets in effect too", async () => {
    const fx = withRules(goodFixture(), [
      pullRequestRule(GOOD_PR_PARAMS),
      { ...statusChecksRule(["test"], true, 900), ruleset_source_type: "Organization", ruleset_source: "acme" },
    ]);
    fx.rulesets[900] = ruleset(900, [], { source_type: "Organization", source: "acme" });
    const a = await run(fx);
    expect(row(a, "agents_cannot_bypass").status).toBe("pass");
    expect(a.reads.map((x) => x.endpoint)).toContain(`GET /repos/${REPO}/rulesets/900?includes_parents=true`);
  });

  it("fails when an Integration bypass actor is an agent app", async () => {
    const fx = goodFixture();
    fx.rulesets = { 42: ruleset(42, [{ actor_id: 31337, actor_type: "Integration", bypass_mode: "always" }]) };
    const a = await run(fx);
    const r = row(a, "agents_cannot_bypass");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["agent_app_can_bypass"]);
    expect(a.identities).toContainEqual(expect.objectContaining({ kind: "app", appId: 31337, source: "detected" }));
  });

  it("fails when a declared agent app is the Integration bypass actor", async () => {
    const fx = goodFixture();
    fx.rulesets = { 42: ruleset(42, [{ actor_id: 555, actor_type: "Integration", bypass_mode: "pull_request" }]) };
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app", name: "Coder App" }) };
    const a = await run(fx, { agents: [], agentApps: ["coder-app"] });
    const r = row(a, "agents_cannot_bypass");
    expect(r.status).toBe("fail");
    expect(r.reasons[0]?.subjects).toEqual(["app coder-app (id 555) on ruleset 42"]);
    expect(a.identities.filter((i) => i.kind === "app")).toHaveLength(1);
  });

  // GitHub does not document which actor_id is which built-in
  // repository role, so a role bypass cannot be matched to an agent's permission.
  for (const roleId of [2, 4, 5, 99]) {
    it(`a RepositoryRole bypass (actor_id ${roleId}) with an agent collaborator is unverifiable, never pass`, async () => {
      const fx = goodFixture();
      fx.rulesets = { 42: ruleset(42, [{ actor_id: roleId, actor_type: "RepositoryRole", bypass_mode: "always" }]) };
      const r = row(await run(fx), "agents_cannot_bypass");
      expect(r.status).toBe("unverifiable");
      expect(codes(r)).toEqual(["bypass_role_unknown"]);
      expect(r.reasons[0]?.subjects).toEqual([`role id ${roleId} on ruleset 42; coder-agent has write`]);
    });
  }

  it("a RepositoryRole bypass is decidable when no agent is a collaborator", async () => {
    const fx = goodFixture();
    fx.rulesets = { 42: ruleset(42, [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }]) };
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app" }) };
    const r = row(await run(fx, { agents: [], agentApps: ["coder-app"] }), "agents_cannot_bypass");
    expect(r.status).toBe("pass");
  });

  it("an agent admin with a RepositoryRole bypass still fails, as agent_is_admin", async () => {
    const fx = goodFixture();
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-agent", "admin")]];
    fx.rulesets = { 42: ruleset(42, [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }]) };
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(r.status).toBe("fail");
    expect(codes(r)).toContain("agent_is_admin");
  });

  // GitHub leaves bypass_pull_request_allowances out when there are
  // none (seen on a live repository, 23 Nov), so its absence is not field_missing.
  it("classic protection with reviews and no bypass_pull_request_allowances field has no allowances", async () => {
    const fx = goodFixture();
    fx.classic = classicProtection({ reviews: { omitAllowances: true } });
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(r.status).toBe("pass");
  });

  it("fails when an OrganizationAdmin bypass covers an agent admin", async () => {
    const fx = goodFixture();
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-agent", "admin")]];
    fx.rulesets = { 42: ruleset(42, [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }]) };
    // The agent is covered only as an organisation owner.
    fx.extra["/orgs/acme/memberships/coder-agent"] = ok({ role: "admin", state: "active" });
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(codes(r)).toEqual(["agent_role_can_bypass", "agent_is_admin"]);
  });

  it("fails when an agent identity has admin permission", async () => {
    const fx = goodFixture();
    fx.rulesets = { 42: ruleset(42, []) };
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-agent", "admin")]];
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["agent_is_admin"]);
  });

  it("fails when classic enforce_admins is false and an agent is an admin", async () => {
    const fx = goodFixture();
    fx.rulesets = { 42: ruleset(42, []) };
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-agent", "admin")]];
    fx.classic = classicProtection({ enforceAdmins: false });
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(codes(r)).toEqual(["agent_is_admin", "admins_not_enforced_agent_is_admin"]);
  });

  it("fails when classic protection lets an agent bypass pull request requirements", async () => {
    const fx = goodFixture();
    fx.classic = classicProtection({ reviews: { bypassUsers: ["coder-agent"] } });
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(codes(r)).toEqual(["agent_in_bypass_allowance"]);
  });

  it("unreadable collaborators are unverifiable", async () => {
    const fx = goodFixture();
    fx.collaborators = FORBIDDEN;
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["collaborators_unreadable"]);
  });

  it("a 403 on the rules endpoint is unverifiable", async () => {
    const fx = goodFixture();
    fx.rules = FORBIDDEN;
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toContain("rules_unreadable");
  });

  it("protected with unreadable classic protection is unverifiable", async () => {
    const fx = goodFixture();
    fx.repo = ok({ full_name: REPO, default_branch: "main", permissions: { admin: false, push: true, pull: true } });
    fx.classic = NOT_FOUND;
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["classic_protection_unreadable"]);
  });
});

describe("classic protection: a 404 is not proof of absence", () => {
  it("an admin user's token that gets a 404 on classic protection makes it unreadable, not absent", async () => {
    const fx = goodFixture();
    fx.classic = NOT_FOUND;
    const a = await run(fx);
    expect(a.classicProtection).toEqual({ state: "unreadable", basis: "not_permitted_or_error" });
    const r = row(a, "agents_cannot_bypass");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["classic_protection_unreadable"]);
  });

  it("check 5 with no required check in the rules and a 404 on classic protection is unverifiable, not fail", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS)]);
    fx.classic = NOT_FOUND;
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["classic_protection_unreadable"]);
  });

  it("a setting the rules require still passes when classic protection is unreadable", async () => {
    const fx = goodFixture();
    fx.classic = NOT_FOUND;
    expect(row(await run(fx), "human_review_required").status).toBe("pass");
  });

  it("only a branch that reports protected: false proves there is no classic protection", async () => {
    const fx = withRules(goodFixture(), []);
    fx.branch = ok({ name: "main", commit: { sha: SHA }, protected: false });
    const a = await run(fx);
    expect(a.classicProtection).toEqual({ state: "absent", basis: "branch_not_protected" });
  });
});

describe("check 5: required_checks_fail_closed", () => {
  it("passes and lists each required context and the up-to-date setting", async () => {
    const r = row(await run(goodFixture()), "required_checks_fail_closed");
    expect(r.status).toBe("pass");
    expect(r.details).toEqual({ requiredChecks: [{ context: "test", appIds: [15368] }], mustBeUpToDate: true, pinnedToGitHubActions: ["test"] });
  });

  it("passes from classic protection", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS)]);
    fx.classic = classicProtection({ contexts: ["build", "lint"], strict: false });
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("pass");
    expect(r.details).toEqual({
      requiredChecks: [
        { context: "build", appIds: [15368] },
        { context: "lint", appIds: [15368] },
      ],
      mustBeUpToDate: false,
      pinnedToGitHubActions: ["build", "lint"],
    });
  });

  it("fails with no_required_checks", async () => {
    const fx = withRules(goodFixture(), [pullRequestRule(GOOD_PR_PARAMS)]);
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["no_required_checks"]);
  });

  it("a 403 on the rules endpoint is unverifiable", async () => {
    const fx = goodFixture();
    fx.rules = FORBIDDEN;
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["rules_unreadable"]);
  });
});

describe("check 6: agent_merges_touching_gates", () => {
  it("gives each agent pull request's gate files, approvers and link, as context", async () => {
    const r = row(await run(goodFixture()), "agent_merges_touching_gates");
    expect(r.status).toBe("context");
    expect(r.details).toEqual({
      requested: 50,
      mergedRead: 2,
      agentMerges: 1,
      agentMergesTouchingGates: 1,
      pullRequests: [
        {
          number: 7,
          url: `https://github.com/${REPO}/pull/7`,
          author: "coder-agent",
          mergedAt: "2026-11-17T12:00:00Z",
          gateFilesChanged: [".github/workflows/ci.yml"],
          candidatesUnknown: [],
          fileListTruncated: false,
          approvers: ["alice"],
        },
      ],
    });
  });

  it("says how many were read when fewer than N merged pull requests exist", async () => {
    const r = row(await run(goodFixture(), { merges: 10 }), "agent_merges_touching_gates");
    expect(r.context.join(" ")).toMatch(/2 merged pull requests were read; 10 were requested/);
  });

  it("reads every page of a pull request's files", async () => {
    const fx = goodFixture();
    fx.pulls = [{ number: 7, author: "coder-agent", files: [["src/a.ts"], ["src/b.ts"], ["vitest.config.ts"]] }];
    const r = row(await run(fx), "agent_merges_touching_gates");
    expect((r.details?.pullRequests as Array<{ gateFilesChanged: string[] }>)[0]?.gateFilesChanged).toEqual(["vitest.config.ts"]);
  });

  it("uses each reviewer's latest review", async () => {
    const fx = goodFixture();
    fx.pulls = [
      {
        number: 7,
        author: "coder-agent",
        files: [["src/a.ts"]],
        reviews: [
          { user: "alice", state: "APPROVED" },
          { user: "bob", state: "APPROVED" },
          { user: "bob", state: "CHANGES_REQUESTED" },
          { user: "carol", state: "APPROVED" },
          { user: "carol", state: "COMMENTED" },
        ],
      },
    ];
    const r = row(await run(fx), "agent_merges_touching_gates");
    expect((r.details?.pullRequests as Array<{ approvers: string[] }>)[0]?.approvers).toEqual(["alice", "carol"]);
  });

  it("stops reading once N merged pull requests are found, and skips unmerged ones", async () => {
    const fx = goodFixture();
    fx.pulls = [
      { number: 9, author: "alice", merged: false },
      { number: 8, author: "alice" },
      { number: 7, author: "coder-agent", files: [["src/a.ts"]] },
    ];
    const r = row(await run(fx, { merges: 1 }), "agent_merges_touching_gates");
    expect(r.details).toMatchObject({ requested: 1, mergedRead: 1, agentMerges: 0 });
  });

  it("an unreadable file list is unverifiable, not a count of zero", async () => {
    const fx = goodFixture();
    fx.pulls = [{ number: 7, author: "coder-agent", filesResponse: SERVER_ERROR }];
    const r = row(await run(fx), "agent_merges_touching_gates");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["pull_request_files_unreadable"]);
  });

  it("a file list at GitHub's 3,000-file cap is unverifiable, not a complete list", async () => {
    const fx = goodFixture();
    const pages = Array.from({ length: 30 }, (_, p) => Array.from({ length: 100 }, (_, i) => `src/f${p * 100 + i}.ts`));
    fx.pulls = [{ number: 7, author: "coder-agent", files: pages, reviews: [{ user: "alice", state: "APPROVED" }] }];
    const r = row(await run(fx), "agent_merges_touching_gates");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["pull_request_files_truncated"]);
    expect(r.reasons[0]?.subjects).toEqual(["#7"]);
  });

  it("a file list just under the cap is complete", async () => {
    const fx = goodFixture();
    const files = Array.from({ length: 2999 }, (_, i) => `src/f${i}.ts`);
    const pages = Array.from({ length: 30 }, (_, p) => files.slice(p * 100, p * 100 + 100)).filter((x) => x.length > 0);
    fx.pulls = [{ number: 7, author: "coder-agent", files: pages }];
    expect(row(await run(fx), "agent_merges_touching_gates").status).toBe("context");
  });

  it("an unreadable pull request list is unverifiable", async () => {
    const fx = goodFixture();
    fx.pullsResponse = FORBIDDEN;
    const r = row(await run(fx), "agent_merges_touching_gates");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["merges_unreadable"]);
  });

  it("reads the pull request list from the configured endpoint", async () => {
    const a = await run(goodFixture());
    expect(a.reads.map((x) => x.endpoint)).toContain(`GET ${PULLS_PATH}`);
  });
});

describe("agent identities", () => {
  it("lists declared identities from flags and from .github/darz.json, with their source", async () => {
    const fx = goodFixture();
    fx.config = ok(fileBody(".github/darz.json", JSON.stringify({ agents: ["helper"], agentApps: ["fixer"], gates: [] })));
    const a = await run(fx, { agents: ["coder-agent"], agentApps: ["coder-app"] });
    const declared = a.identities.filter((i) => i.source === "declared");
    expect(declared.map((i) => [i.kind, i.login ?? i.slug, i.foundIn])).toEqual([
      ["app", "coder-app", ["flag"]],
      ["app", "fixer", ["config"]],
      ["user", "coder-agent", ["flag"]],
      ["user", "helper", ["config"]],
    ]);
  });

  it("detects Bot accounts in collaborators, CODEOWNERS and merge authors", async () => {
    const fx = goodFixture();
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("ci-helper[bot]", "write", "Bot")]];
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @alice\n/docs/ @docs-writer[bot]\n")) };
    fx.pulls = [{ number: 5, author: "dependabot[bot]", files: [["package.json"]] }];
    const a = await run(fx, { agents: [] });
    expect(a.identities.map((i) => [i.slug, i.source, i.foundIn])).toEqual([
      ["ci-helper", "detected", ["collaborators"]],
      ["dependabot", "detected", ["merge_authors"]],
      ["docs-writer", "detected", ["codeowners"]],
    ]);
  });

  it("a declared agent also detected keeps both sources", async () => {
    const fx = goodFixture();
    fx.pulls = [{ number: 5, author: "dependabot[bot]", files: [["package.json"]] }];
    const a = await run(fx, { agents: [], agentApps: ["dependabot"] });
    expect(a.identities).toEqual([
      expect.objectContaining({ kind: "app", slug: "dependabot", source: "declared", foundIn: ["flag", "merge_authors"] }),
    ]);
  });

  it("an invalid .github/darz.json makes checks that depend on it unverifiable", async () => {
    const fx = goodFixture();
    fx.config = ok(fileBody(".github/darz.json", "{ not json"));
    const a = await run(fx);
    for (const id of ["gate_files_owned", "writer_not_approver", "agents_cannot_bypass", "agent_merges_touching_gates"]) {
      expect(row(a, id).status).toBe("unverifiable");
      expect(codes(row(a, id))).toContain("config_invalid");
    }
  });
});

describe("repository unreadable", () => {
  it("marks the assessment unreadable and every check unverifiable", async () => {
    const fx = goodFixture();
    fx.repo = NOT_FOUND;
    const a = await run(fx);
    expect(a.repositoryReadable).toBe(false);
    expect(a.checks.every((c) => c.status === "unverifiable" && codes(c).includes("repository_unreadable"))).toBe(true);
  });
});

describe("a declared agent app whose slug does not resolve", () => {
  it("makes checks 3, 4 and 6 unverifiable with agent_app_unresolved, never pass", async () => {
    const fx = goodFixture();
    fx.apps = { "barg-labs-agnet": NOT_FOUND };
    const a = await run(fx, { agents: [], agentApps: ["barg-labs-agnet"] });
    for (const id of ["writer_not_approver", "agents_cannot_bypass", "agent_merges_touching_gates"]) {
      const r = row(a, id);
      expect(r.status, id).toBe("unverifiable");
      expect(codes(r), id).toEqual(["agent_app_unresolved"]);
      expect(r.reasons[0]?.subjects).toEqual(["barg-labs-agnet (error, 404)"]);
      expect(r.read).toContain("GET /apps/barg-labs-agnet");
    }
  });

  it("names a throttled lookup too", async () => {
    const fx = goodFixture();
    fx.apps = { "coder-app": { status: 403, body: {}, headers: { "x-ratelimit-remaining": "0" } } };
    const a = await run(fx, { agents: [], agentApps: ["coder-app"] });
    expect(row(a, "agents_cannot_bypass").reasons[0]?.subjects).toEqual(["coder-app (error, 403)"]);
  });

  it("does not apply once the slug resolves", async () => {
    const fx = goodFixture();
    fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app", name: "Coder App" }) };
    const a = await run(fx, { agents: [], agentApps: ["coder-app"] });
    for (const id of ["writer_not_approver", "agents_cannot_bypass"]) expect(row(a, id).status, id).toBe("pass");
  });

  it("does not apply to a detected app whose lookup failed", async () => {
    const fx = goodFixture();
    fx.pulls = [{ number: 5, author: "dependabot[bot]", files: [["package.json"]] }];
    const a = await run(fx);
    expect(a.checks.flatMap((c) => codes(c))).not.toContain("agent_app_unresolved");
  });
});

describe("CODEOWNERS lines GitHub reports as errors", () => {
  it("do not make their owners detected agent identities", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @alice\n/docs/ @docs-writer[bot]\n")) };
    fx.codeownersErrors = ok({ errors: [{ line: 2, column: 8, kind: "Unknown owner", path: ".github/CODEOWNERS" }] });
    const a = await run(fx, { agents: [] });
    expect(a.identities).toEqual([]);
  });

  it("still count for detection when the error list cannot be read", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @alice\n/docs/ @docs-writer[bot]\n")) };
    fx.codeownersErrors = FORBIDDEN;
    const a = await run(fx, { agents: [] });
    expect(a.identities.map((i) => i.slug)).toEqual(["docs-writer"]);
  });
});
