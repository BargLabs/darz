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
// - its pin alone gates nothing, since a pull request can add a workflow that
//   posts the check as GitHub Actions: check 5 passes a check pinned only to
//   it while checks 1, 2 and 3 pass, fails when one fails, and is
//   unverifiable when one is; a second pin to another app still gates;
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

  it("check 5 passes a check pinned only to GitHub Actions while checks 1, 2 and 3 pass, and says why", async () => {
    const a = await run(withWorkflowPullRequest());
    for (const id of ["gate_files_owned", "human_review_required", "writer_not_approver"]) expect(row(a, id).status).toBe("pass");
    const r = row(a, "required_checks_fail_closed");
    expect(r.status).toBe("pass");
    expect(codes(r)).toEqual([]);
    expect(r.details?.pinnedToGitHubActions).toEqual(["test"]);
    expect(r.context).toContain(
      "Required checks pinned only to GitHub Actions (app 15368): test. " +
        "The pin alone does not gate them: a pull request from a branch in this repository can add or change a workflow that holds checks: write and posts a check run with that name as GitHub Actions, and GitHub counts that run. " +
        "They hold only while workflow changes need review, which is checks 1, 2 and 3. Checks 1, 2 and 3 pass. " +
        "Not checked: an existing workflow that holds checks: write and runs code a pull request controls can post the same run without the pull request changing a workflow.",
    );
  });

  it("check 5 fails a check pinned only to GitHub Actions when check 1 fails", async () => {
    const fx = withWorkflowPullRequest();
    fx.rules = [[pullRequestRule({ ...GOOD_PR_PARAMS, require_code_owner_review: false }), statusChecksRule(["test"])]];
    const a = await run(fx);
    expect(row(a, "gate_files_owned").status).toBe("fail");
    const r = row(a, "required_checks_fail_closed");
    expect(r.status).toBe("fail");
    expect(r.reasons).toEqual([expect.objectContaining({ code: "required_check_actions_pin_unreviewed", subjects: ["test"] })]);
    expect(r.context.some((c) => c.includes("Check 1 does not pass."))).toBe(true);
  });

  it("check 5 fails it when check 2 fails, though check 1 passes", async () => {
    const fx = withWorkflowPullRequest();
    fx.rules = [[pullRequestRule({ ...GOOD_PR_PARAMS, require_last_push_approval: false }), statusChecksRule(["test"])]];
    const a = await run(fx);
    expect(row(a, "gate_files_owned").status).toBe("pass");
    expect(row(a, "human_review_required").status).toBe("fail");
    const r = row(a, "required_checks_fail_closed");
    expect(codes(r)).toEqual(["required_check_actions_pin_unreviewed"]);
    expect(r.context.some((c) => c.includes("Checks 2 and 3 do not pass."))).toBe(true);
  });

  it("check 5 is unverifiable for it when checks 1, 2 and 3 do not fail but one is unverifiable", async () => {
    const fx = withWorkflowPullRequest();
    const { dismiss_stale_reviews_on_push: _, ...withoutDismiss } = GOOD_PR_PARAMS;
    fx.rules = [[pullRequestRule(withoutDismiss), statusChecksRule(["test"])]];
    const a = await run(fx);
    expect(row(a, "human_review_required").status).toBe("unverifiable");
    const r = row(a, "required_checks_fail_closed");
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["required_check_actions_pin_review_unknown"]);
  });

  it("check 5 does not count a check also pinned to another app by another source, since GitHub enforces both pins", async () => {
    const fx = withWorkflowPullRequest();
    fx.rules = [[pullRequestRule({ ...GOOD_PR_PARAMS, require_code_owner_review: false }), statusChecksRule(["test"]), statusChecksRule(["test"], true, 43, 777)]];
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.details?.requiredChecks).toEqual([{ context: "test", appIds: [777, ACTIONS_APP_ID] }]);
    expect(r.details?.pinnedToGitHubActions).toEqual([]);
    expect(codes(r)).not.toContain("required_check_actions_pin_unreviewed");
    expect(r.context.some((c) => c.startsWith("Required checks pinned only to GitHub Actions"))).toBe(false);
  });

  it("check 5 has no such line when no required check is pinned to GitHub Actions", async () => {
    const fx = goodFixture();
    fx.rules = [[pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test"], true, 42, 777)]];
    const r = row(await run(fx), "required_checks_fail_closed");
    expect(r.details?.pinnedToGitHubActions).toEqual([]);
    expect(r.context.some((c) => c.startsWith("Required checks pinned only to GitHub Actions"))).toBe(false);
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
