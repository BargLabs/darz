// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Check 6 judges a changed package.json, vite.config.*,
// pyproject.toml or setup.cfg by its contents at each merge commit, not at
// the default branch's head.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import { MAX_MERGE_CANDIDATE_READS } from "../src/gates.js";
import type { FakeResponse } from "./helpers/fake-fetch.js";
import {
  type Fixture,
  NOT_FOUND,
  REPO,
  SERVER_ERROR,
  b64,
  fileBody,
  fixtureFetch,
  goodFixture,
  mergeSha,
  ok,
  tree,
} from "./fixtures/github.js";

const R = `/repos/${REPO}`;
const WITH_TESTS = JSON.stringify({ scripts: { test: "vitest run" } });
const WITHOUT_TESTS = JSON.stringify({ scripts: { build: "tsc" } });
const PARENT = "2222222222222222222222222222222222222222";
const REMOVED_BLOB = "3333333333333333333333333333333333333333";
const SHA_OTHER = "4444444444444444444444444444444444444444";

async function run(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<{ a: Assessment; urls: string[] }> {
  const f = fixtureFetch(fx);
  const a = await assess({
    repo: REPO,
    fetch: f.fetch,
    agents: ["coder-agent"],
    now: () => new Date("2026-11-23T12:00:00Z"),
    ...extra,
  });
  return { a, urls: f.calls.map((c) => c.url.replace("https://api.github.com", "")) };
}

function row(a: Assessment): CheckRow {
  const r = a.checks.find((c) => c.id === "agent_merges_touching_gates");
  if (!r) throw new Error("no row 6");
  return r;
}

const codes = (r: CheckRow) => r.reasons.map((x) => x.code);
const prs = (r: CheckRow) =>
  r.details?.pullRequests as Array<{ number: number; gateFilesChanged: string[] | null; candidatesUnknown: string[] }>;
const atMerge = (path: string, n = 7, ref = mergeSha(n)) => `${R}/contents/${path}?ref=${ref}`;

/** A repository whose head package.json holds `head`, and the agent's merged pull request, number 7, changed package.json. */
function fixture(head: string, files: string[] = ["package.json", "src/index.ts"]): Fixture {
  const fx = goodFixture();
  fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml", "src/index.ts", "package.json"]);
  fx.blobs = { "package.json": head };
  fx.pulls = [{ number: 7, author: "coder-agent", files: [files], reviews: [{ user: "alice", state: "APPROVED" }] }];
  return fx;
}

function filesResponse(entries: Array<Record<string, string>>): FakeResponse {
  return ok(entries);
}

describe("check 6 judges candidate files at each merge commit", () => {
  it("counts a candidate that held test settings at the merge, though it holds none at the head", async () => {
    const fx = fixture(WITHOUT_TESTS);
    fx.extra[atMerge("package.json")] = ok(fileBody("package.json", WITH_TESTS));
    const { a } = await run(fx);
    const r = row(a);
    expect(r.status).toBe("context");
    expect(prs(r)[0]?.gateFilesChanged).toEqual(["package.json"]);
    expect(r.read).toContain(`GET ${atMerge("package.json")}`);
    expect(r.details).toMatchObject({ agentMergesTouchingGates: 1 });
  });

  it("does not count a candidate that held no test settings at the merge, though it holds them at the head", async () => {
    const fx = fixture(WITH_TESTS);
    fx.extra[atMerge("package.json")] = ok(fileBody("package.json", WITHOUT_TESTS));
    const { a } = await run(fx);
    const r = row(a);
    expect(r.status).toBe("context");
    expect(prs(r)[0]?.gateFilesChanged).toEqual([]);
    expect(prs(r)[0]?.candidatesUnknown).toEqual([]);
    // Check 1 still judges the head.
    expect(a.checks.find((c) => c.id === "gate_files_owned")?.status).toBe("pass");
  });

  it("judges a removed candidate by the blob the pull request removed, with no read at the merge", async () => {
    const fx = fixture(WITHOUT_TESTS);
    fx.pulls = [
      {
        number: 7,
        author: "coder-agent",
        filesResponse: filesResponse([{ filename: "packages/a/package.json", status: "removed", sha: REMOVED_BLOB }]),
      },
    ];
    fx.extra[`${R}/git/blobs/${REMOVED_BLOB}`] = ok({ sha: REMOVED_BLOB, encoding: "base64", content: b64(WITH_TESTS) });
    const { a, urls } = await run(fx);
    const r = row(a);
    expect(r.status).toBe("context");
    expect(prs(r)[0]?.gateFilesChanged).toEqual(["packages/a/package.json"]);
    expect(r.read).toContain(`GET ${R}/git/blobs/${REMOVED_BLOB}`);
    expect(urls).not.toContain(atMerge("packages/a/package.json"));
  });

  it("judges a rename's old name at the merge commit's first parent, and its new name at the merge", async () => {
    const fx = fixture(WITHOUT_TESTS);
    fx.pulls = [
      {
        number: 7,
        author: "coder-agent",
        filesResponse: filesResponse([
          { filename: "vite.config.mts", previous_filename: "vite.config.ts", status: "renamed", sha: REMOVED_BLOB },
        ]),
      },
    ];
    fx.extra[`${R}/git/commits/${mergeSha(7)}`] = ok({ sha: mergeSha(7), parents: [{ sha: PARENT }, { sha: SHA_OTHER }] });
    fx.extra[atMerge("vite.config.ts", 7, PARENT)] = ok(fileBody("vite.config.ts", "export default { test: { environment: 'node' } }\n"));
    fx.extra[atMerge("vite.config.mts")] = ok(fileBody("vite.config.mts", "export default { build: {} }\n"));
    const { a } = await run(fx);
    const r = row(a);
    expect(r.status).toBe("context");
    expect(prs(r)[0]?.gateFilesChanged).toEqual(["vite.config.ts"]);
    expect(r.read).toEqual(
      expect.arrayContaining([
        `GET ${R}/git/commits/${mergeSha(7)}`,
        `GET ${atMerge("vite.config.ts", 7, PARENT)}`,
        `GET ${atMerge("vite.config.mts")}`,
      ]),
    );
  });

  const failures: Array<[string, FakeResponse | string, string]> = [
    ["a read that fails", SERVER_ERROR, "not read"],
    ["a file missing at the merge commit", NOT_FOUND, "not found at the merge commit"],
    ["a file that cannot be parsed", "{ not json", "not parseable"],
  ];
  for (const [name, res, why] of failures) {
    it(`${name} is unverifiable for that pull request, naming the file`, async () => {
      const fx = fixture(WITH_TESTS);
      fx.extra[atMerge("package.json")] = typeof res === "string" ? ok(fileBody("package.json", res)) : res;
      const { a } = await run(fx);
      const r = row(a);
      expect(r.status).toBe("unverifiable");
      expect(codes(r)).toEqual(["gate_candidate_at_merge_unreadable"]);
      expect(r.reasons[0]?.subjects).toEqual([`#7: package.json (${why})`]);
      expect(prs(r)[0]?.gateFilesChanged).toEqual([]);
      expect(prs(r)[0]?.candidatesUnknown).toEqual(["package.json"]);
    });
  }

  it("a merged pull request without a merge commit SHA is unverifiable for its candidates", async () => {
    const fx = fixture(WITH_TESTS);
    fx.pullsResponse = ok([
      {
        number: 7,
        html_url: `https://github.com/${REPO}/pull/7`,
        user: { login: "coder-agent", type: "User" },
        merged_at: "2026-11-17T12:00:00Z",
        updated_at: "2026-11-17T12:00:00Z",
      },
    ]);
    const { a } = await run(fx);
    const r = row(a);
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["gate_candidate_at_merge_unreadable"]);
    expect(r.reasons[0]?.subjects).toEqual(["#7: package.json (no merge commit SHA)"]);
  });

  it("reads nothing more for an agent pull request that changed no candidate file", async () => {
    const { a, urls } = await run(goodFixture());
    expect(row(a).status).toBe("context");
    expect(urls.filter((u) => u.includes("/contents/") && u.includes(mergeSha(7)))).toEqual([]);
    expect(urls.filter((u) => u.includes("/git/commits/"))).toEqual([]);
  });

  it("caps the extra reads, newest merge first; a pull request past the cap is unverifiable, not read", async () => {
    const half = Math.ceil(MAX_MERGE_CANDIDATE_READS * 0.6);
    const files = (p: string) => Array.from({ length: half }, (_, i) => `${p}${i}/package.json`);
    const fx = goodFixture();
    fx.pulls = [
      { number: 8, author: "coder-agent", files: [files("a/")] },
      { number: 7, author: "coder-agent", files: [files("b/")] },
    ];
    for (const f of files("a/")) fx.extra[atMerge(f, 8)] = ok(fileBody(f, WITH_TESTS));
    for (const f of files("b/")) fx.extra[atMerge(f, 7)] = ok(fileBody(f, WITH_TESTS));
    const { a, urls } = await run(fx);
    const r = row(a);
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["gate_candidates_at_merge_over_cap"]);
    expect(r.reasons[0]?.subjects).toEqual(["#7"]);
    const extra = urls.filter((u) => u.includes("/contents/") && (u.includes(mergeSha(7)) || u.includes(mergeSha(8))));
    expect(extra).toHaveLength(half);
    expect(extra.every((u) => u.includes(mergeSha(8)))).toBe(true);
    const byNumber = new Map(prs(r).map((p) => [p.number, p]));
    expect(byNumber.get(8)?.gateFilesChanged).toHaveLength(half);
    expect(byNumber.get(7)?.gateFilesChanged).toEqual([]);
    expect(byNumber.get(7)?.candidatesUnknown).toHaveLength(half);
  });

  it("a pattern that already makes a candidate path a gate file needs no read at the merge", async () => {
    const fx = fixture(WITHOUT_TESTS);
    const { a, urls } = await run(fx, { gates: ["package.json"] });
    expect(prs(row(a))[0]?.gateFilesChanged).toEqual(["package.json"]);
    expect(urls).not.toContain(atMerge("package.json"));
  });
});
