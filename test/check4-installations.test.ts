// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// An agent app's installation permissions, such as
// administration: write, let it change rulesets or branch protection.
// GET /repos/{owner}/{repo}/installation needs an app JWT, but
// GET /orgs/{org}/installations, readable with an organisation owner's token
// or organisation Administration: read, lists each installation's
// app_id, app_slug and permissions. Check 4 reads it when it can. When it
// cannot (the GitHub Actions workflow token never can), a context line says
// so and the row is decided as before.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import { API, type FakeResponse, fakeFetch } from "./helpers/fake-fetch.js";
import { FORBIDDEN, type Fixture, NOT_FOUND, OWNER, REPO, goodFixture, ok, toRoutes } from "./fixtures/github.js";

const INSTALLATIONS = `/orgs/${OWNER}/installations?per_page=100`;

async function runWithCalls(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<{ a: Assessment; urls: string[] }> {
  const f = fakeFetch(toRoutes(fx));
  const a = await assess({
    repo: REPO,
    fetch: f.fetch,
    agents: [],
    agentApps: ["coder-app=555"],
    now: () => new Date("2026-11-24T12:00:00Z"),
    ...extra,
  });
  return { a, urls: f.calls.map((c) => c.url.replace(API, "")) };
}

function row(a: Assessment): CheckRow {
  const r = a.checks.find((c) => c.id === "agents_cannot_bypass");
  if (!r) throw new Error("no row");
  return r;
}
const codes = (r: CheckRow) => r.reasons.map((x) => x.code);

function installation(appId: number, slug: string, permissions: Record<string, string> | undefined, selection = "all") {
  const i: Record<string, unknown> = { id: appId + 9000, app_id: appId, app_slug: slug, target_type: "Organization", repository_selection: selection };
  if (permissions !== undefined) i.permissions = permissions;
  return i;
}

function withInstallations(res: FakeResponse | unknown[]): Fixture {
  const fx = goodFixture();
  fx.pulls = [{ number: 6, author: "alice", files: [["README.md"]] }];
  fx.apps = { "coder-app": ok({ id: 555, slug: "coder-app" }) };
  fx.extra[INSTALLATIONS] = Array.isArray(res) ? ok({ total_count: res.length, installations: res }) : res;
  return fx;
}

const OTHER = installation(8329, "vercel", { administration: "write", contents: "write", metadata: "read" }, "selected");

describe("agent app installation permissions in check 4", () => {
  it("an agent app whose installation has administration: write fails", async () => {
    const fx = withInstallations([OTHER, installation(555, "coder-app", { administration: "write", contents: "write", metadata: "read" })]);
    const r = row((await runWithCalls(fx)).a);
    expect(r.status).toBe("fail");
    expect(codes(r)).toEqual(["agent_app_can_administer"]);
    expect(r.reasons[0]?.subjects).toEqual(["app coder-app (id 555): administration: write (installation 9555, repository_selection all)"]);
    expect(r.read).toContain(`GET ${INSTALLATIONS}`);
    expect(r.context.some((c) => c.includes("installation permissions") && c.includes("not checked"))).toBe(false);
  });

  it("organization_administration: write fails too: it can change organisation rulesets", async () => {
    const fx = withInstallations([installation(555, "coder-app", { organization_administration: "write", contents: "write" }, "selected")]);
    const r = row((await runWithCalls(fx)).a);
    expect(codes(r)).toEqual(["agent_app_can_administer"]);
    expect(r.reasons[0]?.subjects).toEqual([
      "app coder-app (id 555): organization_administration: write (installation 9555, repository_selection selected)",
    ]);
  });

  it("read-only administration and other write permissions pass; another app's administration: write is not the agent's", async () => {
    const fx = withInstallations([OTHER, installation(555, "coder-app", { administration: "read", contents: "write", workflows: "write" })]);
    const r = row((await runWithCalls(fx)).a);
    expect(r.status).toBe("pass");
  });

  it("an app known only by slug is matched by app_slug", async () => {
    const fx = withInstallations([installation(555, "coder-app", { administration: "write" })]);
    fx.apps = { "coder-app": NOT_FOUND };
    fx.pulls = [{ number: 6, author: "coder-app[bot]", files: [["README.md"]], reviews: [{ user: "alice", state: "APPROVED" }] }];
    const r = row((await runWithCalls(fx, { agentApps: [], agents: ["coder-agent"] })).a);
    expect(codes(r)).toEqual(["agent_app_can_administer"]);
    expect(r.reasons[0]?.subjects?.[0]).toMatch(/^app coder-app: administration: write/);
  });

  it("reads every page of installations", async () => {
    const fx = withInstallations([]);
    fx.extra[INSTALLATIONS] = ok(
      { total_count: 2, installations: [OTHER] },
      { link: `<${API}${INSTALLATIONS}&page=2>; rel="next", <${API}${INSTALLATIONS}&page=2>; rel="last"` },
    );
    fx.extra[`${INSTALLATIONS}&page=2`] = ok({ total_count: 2, installations: [installation(555, "coder-app", { administration: "write" })] });
    const r = row((await runWithCalls(fx)).a);
    expect(codes(r)).toEqual(["agent_app_can_administer"]);
  });

  it("repository_custom_properties: write is a context line, not a fail", async () => {
    const fx = withInstallations([installation(555, "coder-app", { repository_custom_properties: "write", contents: "write" })]);
    const r = row((await runWithCalls(fx)).a);
    expect(r.status).toBe("pass");
    expect(r.context.some((c) => c.startsWith("Agent app coder-app's installation has repository_custom_properties: write."))).toBe(true);
  });

  it("an agent app with no installation on the organisation passes, with a context line", async () => {
    const fx = withInstallations([OTHER]);
    const r = row((await runWithCalls(fx)).a);
    expect(r.status).toBe("pass");
    expect(r.context).toContain(`Agent app coder-app has no installation on organisation ${OWNER}, so it holds no installation permissions on this repository.`);
  });

  it("an installation with no permissions object is unverifiable", async () => {
    const fx = withInstallations([installation(555, "coder-app", undefined)]);
    const r = row((await runWithCalls(fx)).a);
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["field_missing"]);
    expect(r.reasons[0]?.subjects).toEqual(["installations[app_id=555].permissions"]);
  });

  const unreadable: Array<[string, FakeResponse, string]> = [
    ["403", FORBIDDEN, "not_permitted, 403"],
    ["404", NOT_FOUND, "not_permitted, 404"],
  ];
  for (const [name, res, why] of unreadable) {
    it(`a ${name} on the installations list leaves the row as it was, with a context line`, async () => {
      const fx = withInstallations(res);
      const r = row((await runWithCalls(fx)).a);
      expect(r.status).toBe("pass");
      const line = r.context.find((c) => c.startsWith("GitHub App installation permissions of agent apps were not checked"));
      expect(line).toBeDefined();
      expect(line).toContain(`GET ${INSTALLATIONS} was ${why}`);
    });
  }

  it("a repository owned by a user: nothing is read, and a context line says why", async () => {
    const fx = withInstallations([installation(555, "coder-app", { administration: "write" })]);
    fx.repo = ok({ full_name: REPO, default_branch: "main", private: true, owner: { login: OWNER, type: "User" } });
    const { a, urls } = await runWithCalls(fx);
    const r = row(a);
    expect(r.status).toBe("pass");
    expect(urls.some((u) => u.startsWith("/orgs/"))).toBe(false);
    expect(r.context.some((c) => c.startsWith("GitHub App installation permissions of agent apps were not checked") && c.includes("owned by a user"))).toBe(true);
  });

  it("with no app agent, the installations are not read and no line is added", async () => {
    const fx = withInstallations([installation(555, "coder-app", { administration: "write" })]);
    const { a, urls } = await runWithCalls(fx, { agentApps: [], agents: ["coder-agent"] });
    expect(urls.some((u) => u.includes("/installations"))).toBe(false);
    expect(row(a).context.some((c) => c.includes("installation permissions"))).toBe(false);
  });
});
