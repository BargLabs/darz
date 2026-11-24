// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Hand-written fixtures shaped like GitHub REST responses (API version
// 2022-11-28). No network: every test answers from these.

import { createHash } from "node:crypto";
import { type FakeResponse, type Routes, fakeFetch, ok, paged } from "../helpers/fake-fetch.js";

export { ok };

export const OWNER = "acme";
export const NAME = "widget";
export const REPO = `${OWNER}/${NAME}`;
export const SHA = "1111111111111111111111111111111111111111";
const R = `/repos/${REPO}`;

/** GitHub Actions' app id, the usual source a required check is pinned to. */
export const ACTIONS_APP_ID = 15368;

/** A stable, distinct blob SHA per path, so blob reads can be routed by SHA. */
export function blobSha(path: string): string {
  return createHash("sha1").update(`blob:${path}`).digest("hex");
}

/** A stable merge commit SHA per pull request number. */
export function mergeSha(number: number): string {
  return createHash("sha1").update(`merge:${number}`).digest("hex");
}

export function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export function fileBody(path: string, text: string) {
  return { type: "file", path, encoding: "base64", content: b64(text), size: text.length };
}

export interface PullFixture {
  number: number;
  author: string;
  authorType?: "User" | "Bot";
  merged?: boolean;
  files?: string[][];
  reviews?: Array<{ user: string; state: string }>;
  filesResponse?: FakeResponse;
}

export interface Fixture {
  repo: FakeResponse;
  branch: FakeResponse;
  tree: FakeResponse;
  codeowners: Partial<Record<".github/CODEOWNERS" | "CODEOWNERS" | "docs/CODEOWNERS", FakeResponse>>;
  codeownersErrors: FakeResponse;
  rules: FakeResponse | unknown[][];
  classic: FakeResponse;
  rulesets: Record<number, FakeResponse>;
  collaborators: FakeResponse | unknown[][];
  config: FakeResponse;
  pulls: PullFixture[];
  pullsResponse?: FakeResponse;
  apps: Record<string, FakeResponse>;
  /** File contents by path, served at GET /git/blobs/{sha} for that path's tree entry. */
  blobs: Record<string, FakeResponse | string>;
  extra: Routes;
}

export const GOOD_CODEOWNERS = "# Gate files need a human owner.\n* @alice\n/.github/ @alice\n/vitest.config.ts @alice\n";

export const GOOD_TREE = [
  ".github/CODEOWNERS",
  ".github/workflows/ci.yml",
  "README.md",
  "src/index.ts",
  "test/index.test.ts",
  "vitest.config.ts",
];

export function tree(paths: string[], truncated = false): FakeResponse {
  return ok({
    sha: SHA,
    tree: paths.map((path) => ({ path, mode: "100644", type: "blob", sha: blobSha(path) })),
    truncated,
  });
}

export function pullRequestRule(params: Record<string, unknown>, rulesetId = 42) {
  return {
    type: "pull_request",
    parameters: params,
    ruleset_source_type: "Repository",
    ruleset_source: REPO,
    ruleset_id: rulesetId,
  };
}

export const GOOD_PR_PARAMS = {
  required_approving_review_count: 1,
  dismiss_stale_reviews_on_push: true,
  require_code_owner_review: true,
  require_last_push_approval: true,
  required_review_thread_resolution: false,
};

/**
 * A required_status_checks rule. Each check is pinned to `integrationId`
 * (GitHub Actions by default); null leaves it unpinned, as GitHub returns it
 * when any source may report the check: no integration_id field.
 */
export function statusChecksRule(contexts: string[], strict = true, rulesetId = 42, integrationId: number | null = ACTIONS_APP_ID) {
  return {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: strict,
      required_status_checks: contexts.map((context) =>
        integrationId === null ? { context } : { context, integration_id: integrationId },
      ),
    },
    ruleset_source_type: "Repository",
    ruleset_source: REPO,
    ruleset_id: rulesetId,
  };
}

export function ruleset(id: number, bypassActors: unknown[] | undefined, extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = {
    id,
    name: `ruleset ${id}`,
    target: "branch",
    source_type: "Repository",
    source: REPO,
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [],
    ...extra,
  };
  if (bypassActors !== undefined) body.bypass_actors = bypassActors;
  return ok(body);
}

export function collaborator(login: string, level: "admin" | "maintain" | "write" | "triage" | "read", type = "User") {
  const order = ["read", "triage", "write", "maintain", "admin"];
  const at = order.indexOf(level);
  return {
    login,
    type,
    permissions: { pull: at >= 0, triage: at >= 1, push: at >= 2, maintain: at >= 3, admin: at >= 4 },
    role_name: level,
  };
}

export const NOT_FOUND: FakeResponse = { status: 404, body: { message: "Not Found" } };
export const FORBIDDEN: FakeResponse = { status: 403, body: { message: "Resource not accessible by integration" } };
export const SERVER_ERROR: FakeResponse = { status: 500, body: { message: "Server Error" } };

/**
 * A repository whose gate holds: every check passes for the declared agent
 * `coder-agent`, a user with write access.
 */
export function goodFixture(): Fixture {
  return {
    repo: ok({
      full_name: REPO,
      default_branch: "main",
      private: true,
      owner: { login: OWNER, type: "Organization" },
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    }),
    branch: ok({ name: "main", commit: { sha: SHA }, protected: true }),
    tree: tree(GOOD_TREE),
    codeowners: { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", GOOD_CODEOWNERS)) },
    codeownersErrors: ok({ errors: [] }),
    rules: [[pullRequestRule(GOOD_PR_PARAMS), statusChecksRule(["test"])]],
    classic: classicProtection({}),
    rulesets: { 42: ruleset(42, []) },
    collaborators: [[collaborator("alice", "admin"), collaborator("coder-agent", "write")]],
    config: NOT_FOUND,
    pulls: [
      {
        number: 7,
        author: "coder-agent",
        files: [[".github/workflows/ci.yml", "src/index.ts"]],
        reviews: [{ user: "alice", state: "APPROVED" }],
      },
      { number: 6, author: "alice", files: [["README.md"]], reviews: [] },
    ],
    apps: {},
    blobs: {},
    extra: {},
  };
}

function listRoutes(path: string, value: FakeResponse | unknown[][]): Routes {
  if (Array.isArray(value)) return paged(path, value);
  return { [path]: value };
}

export const PULLS_PATH = `${R}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100`;

export function toRoutes(fx: Fixture): Routes {
  const routes: Routes = {
    [R]: fx.repo,
    [`${R}/branches/main`]: fx.branch,
    [`${R}/git/trees/${SHA}?recursive=1`]: fx.tree,
    [`${R}/codeowners/errors?ref=${SHA}`]: fx.codeownersErrors,
    [`${R}/branches/main/protection`]: fx.classic,
    [`${R}/contents/.github/darz.json?ref=${SHA}`]: fx.config,
    ...listRoutes(`${R}/rules/branches/main?per_page=100`, fx.rules),
    ...listRoutes(`${R}/collaborators?affiliation=all&per_page=100`, fx.collaborators),
  };
  for (const [path, res] of Object.entries(fx.codeowners)) {
    routes[`${R}/contents/${path}?ref=${SHA}`] = res as FakeResponse;
  }
  for (const [id, res] of Object.entries(fx.rulesets)) {
    routes[`${R}/rulesets/${id}?includes_parents=true`] = res;
  }
  for (const [slug, res] of Object.entries(fx.apps)) {
    routes[`/apps/${slug}`] = res;
  }
  const pulls = fx.pulls.map((p) => ({
    number: p.number,
    html_url: `https://github.com/${REPO}/pull/${p.number}`,
    user: { login: p.author, type: p.authorType ?? (p.author.endsWith("[bot]") ? "Bot" : "User") },
    merged_at: p.merged === false ? null : `2026-11-${String(10 + (p.number % 15)).padStart(2, "0")}T12:00:00Z`,
    merge_commit_sha: mergeSha(p.number),
    // Merging sets updated_at, so a merged fixture was last updated when it merged.
    updated_at: `2026-11-${String(10 + (p.number % 15)).padStart(2, "0")}T12:00:00Z`,
    base: { ref: "main" },
  }));
  if (fx.pullsResponse) routes[PULLS_PATH] = fx.pullsResponse;
  else Object.assign(routes, paged(PULLS_PATH, [pulls]));
  for (const p of fx.pulls) {
    const filesPath = `${R}/pulls/${p.number}/files?per_page=100`;
    if (p.filesResponse) routes[filesPath] = p.filesResponse;
    else Object.assign(routes, paged(filesPath, (p.files ?? [[]]).map((page) => page.map((filename) => ({ filename, status: "modified" })))));
    Object.assign(
      routes,
      paged(`${R}/pulls/${p.number}/reviews?per_page=100`, [
        (p.reviews ?? []).map((r, i) => ({ id: i + 1, user: { login: r.user, type: "User" }, state: r.state })),
      ]),
    );
  }
  for (const [path, res] of Object.entries(fx.blobs)) {
    routes[`${R}/git/blobs/${blobSha(path)}`] =
      typeof res === "string" ? ok({ sha: blobSha(path), encoding: "base64", content: b64(res), size: res.length }) : res;
  }
  Object.assign(routes, fx.extra);
  return routes;
}

export function fixtureFetch(fx: Fixture) {
  return fakeFetch(toRoutes(fx));
}

export interface ClassicOptions {
  reviews?: {
    count?: number;
    dismissStale?: boolean;
    codeOwners?: boolean;
    lastPush?: boolean;
    bypassUsers?: string[];
    /** Leave bypass_pull_request_allowances out, as GitHub does when there are none. */
    omitAllowances?: boolean;
    bypassApps?: string[];
  } | null;
  enforceAdmins?: boolean;
  contexts?: string[] | null;
  /** The app each classic required check is pinned to; null for any source. Default GitHub Actions. */
  checkAppId?: number | null;
  /** Only the legacy contexts list, with no checks array (unpinned). */
  legacyContextsOnly?: boolean;
  strict?: boolean;
}

export function classicProtection(o: ClassicOptions): FakeResponse {
  const body: Record<string, unknown> = {
    url: `https://api.github.com${R}/branches/main/protection`,
    enforce_admins: { enabled: o.enforceAdmins ?? true },
    restrictions: null,
  };
  if (o.contexts !== undefined && o.contexts !== null) {
    body.required_status_checks = {
      strict: o.strict ?? true,
      contexts: o.contexts,
      ...(o.legacyContextsOnly
        ? {}
        : { checks: o.contexts.map((context) => ({ context, app_id: o.checkAppId === undefined ? ACTIONS_APP_ID : o.checkAppId })) }),
    };
  }
  if (o.reviews) {
    body.required_pull_request_reviews = {
      required_approving_review_count: o.reviews.count ?? 1,
      dismiss_stale_reviews: o.reviews.dismissStale ?? true,
      require_code_owner_reviews: o.reviews.codeOwners ?? true,
      require_last_push_approval: o.reviews.lastPush ?? true,
      ...(o.reviews.omitAllowances
        ? {}
        : {
          bypass_pull_request_allowances: {
            users: (o.reviews.bypassUsers ?? []).map((login) => ({ login, type: "User" })),
            teams: [],
            apps: (o.reviews.bypassApps ?? []).map((slug) => ({ slug, name: slug })),
          },
          }),
    };
  }
  return ok(body);
}
