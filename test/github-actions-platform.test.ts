// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// github-actions[bot] is GitHub Actions' own identity: every workflow's token
// acts as it, and most repositories pin their required checks to its app
// (15368). Detected as an agent because a workflow opened a merged pull
// request, it made check 5 fail on the standard setup. It is a platform
// identity, not an agent:
// - it is not detected from merge authors, collaborators or CODEOWNERS;
// - a ruleset that lets GitHub Actions bypass it still fails check 4, since
//   then any workflow can go around the rules;
// - declared explicitly, it is still an agent;
// - check 5 passes a check pinned to it, and says in its context that a
//   workflow with checks: write can post that app's check runs;
// - check 6 says how many of its merges were left out.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import {
  ACTIONS_APP_ID,
  type Fixture,
  GOOD_PR_PARAMS,
  REPO,
  collaborator,
  fixtureFetch,
  goodFixture,
  ok,
  pullRequestRule,
  ruleset,
  statusChecksRule,
} from "./fixtures/github.js";

async function run(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<Assessment> {
  return assess({ repo: REPO, fetch: fixtureFetch(fx).fetch, agents: ["coder-agent"], now: () => new Date("2026-11-24T12:00:00Z"), ...extra });
}
function row(a: Assessment, id: string): CheckRow {
  const r = a.checks.find((c) => c.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}
const codes = (r: CheckRow) => r.reasons.map((x) => x.code);

/** The standard setup: `test` pinned to GitHub Actions, and a merged pull request opened by a workflow. */
function withWorkflowPullRequest(): Fixture {
  const fx = goodFixture();
  fx.pulls.push({ number: 8, author: "github-actions[bot]", files: [["CHANGELOG.md"]], reviews: [{ user: "alice", state: "APPROVED" }] });
  fx.apps = { "github-actions": ok({ id: ACTIONS_APP_ID, slug: "github-actions" }) };
  return fx;
}

describe("github-actions[bot] is a platform identity, not an agent", () => {
  it("is not detected from the authors of merged pull requests", async () => {
    const a = await run(withWorkflowPullRequest());
    expect(a.identities.map((i) => i.login ?? i.slug)).toEqual(["coder-agent"]);
  });

  it("is not detected from the collaborators list or CODEOWNERS", async () => {
    const fx = goodFixture();
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-agent", "write"), { ...collaborator("github-actions[bot]", "write"), type: "Bot" }]];
    fx.apps = { "github-actions": ok({ id: ACTIONS_APP_ID, slug: "github-actions" }) };
    const a = await run(fx);
    expect(a.identities.map((i) => i.login ?? i.slug)).toEqual(["coder-agent"]);
  });

  it("check 5 passes a required check pinned to GitHub Actions, and says what that pin does not stop", async () => {
    const r = row(await run(withWorkflowPullRequest()), "required_checks_fail_closed");
    expect(r.status).toBe("pass");
    expect(codes(r)).toEqual([]);
    expect(r.details?.pinnedToGitHubActions).toEqual(["test"]);
    const line = r.context.find((c) => c.startsWith("Required checks pinned to GitHub Actions"));
    expect(line).toContain("test");
    expect(line).toContain("checks: write");
  });

  it("check 5 has no such line when no required check is pinned to GitHub Actions", async () => {
    const fx = goodFixture();
    fx.rules = [[pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test"], true, 42, 777)]];
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.details?.pinnedToGitHubActions).toEqual([]);
    expect(r.context.some((c) => c.startsWith("Required checks pinned to GitHub Actions"))).toBe(false);
  });

  it("check 6 leaves its merges out and says how many", async () => {
    const r = row(await run(withWorkflowPullRequest()), "agent_merges_touching_gates");
    const authors = ((r.details?.pullRequests ?? []) as Array<{ author: string }>).map((p) => p.author);
    expect(authors).not.toContain("github-actions[bot]");
    expect(r.context).toContain("1 merged pull request by github-actions[bot] is not counted: it is GitHub Actions' identity for workflows, not an agent.");
  });

  it("declared explicitly, it is still an agent, and check 5 fails as before", async () => {
    const a = await run(withWorkflowPullRequest(), { agentApps: ["github-actions"] });
    expect(a.identities.map((i) => i.slug ?? i.login)).toContain("github-actions");
    const r = row(a, "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["required_check_pinned_to_agent_app"]);
    expect(row(a, "agent_merges_touching_gates").context.some((c) => c.includes("is not counted"))).toBe(false);
  });

  it("a ruleset that lets GitHub Actions bypass it still fails check 4", async () => {
    const fx = withWorkflowPullRequest();
    fx.rulesets = { 42: ruleset(42, [{ actor_id: ACTIONS_APP_ID, actor_type: "Integration", bypass_mode: "always" }]) };
    const r = row(await run(fx), "agents_cannot_bypass");
    expect(r.status).toBe("fail");
    expect(codes(r)).toContain("agent_app_can_bypass");
  });

  it("allowed to bypass a ruleset, it is an agent in check 6 too, as in checks 4 and 5", async () => {
    const fx = withWorkflowPullRequest();
    fx.rulesets = { 42: ruleset(42, [{ actor_id: ACTIONS_APP_ID, actor_type: "Integration", bypass_mode: "always" }]) };
    const a = await run(fx);
    expect(codes(row(a, "required_checks_fail_closed"))).toEqual(["required_check_pinned_to_agent_app"]);
    const r = row(a, "agent_merges_touching_gates");
    const authors = ((r.details?.pullRequests ?? []) as Array<{ author: string }>).map((p) => p.author);
    expect(authors).toContain("github-actions[bot]");
    expect(r.context.some((c) => c.includes("is not counted"))).toBe(false);
  });
});
