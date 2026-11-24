// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Check 6 reads closed pull requests by update time. A pull request
// merged long ago but updated recently must not take the place of a recent
// merge, so Darz reads on until no later merge can be missing.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import { GitHubClient } from "../src/github/client.js";
import { MERGE_EXTRA_PAGES } from "../src/github/snapshot.js";
import { fakeFetch, paged } from "./helpers/fake-fetch.js";
import { type Fixture, PULLS_PATH, REPO, fixtureFetch, goodFixture } from "./fixtures/github.js";

async function run(fx: Fixture, extra: Partial<AssessOptions> = {}): Promise<{ a: Assessment; urls: string[] }> {
  const f = fixtureFetch(fx);
  const a = await assess({
    repo: REPO,
    fetch: f.fetch,
    agents: ["coder-agent"],
    now: () => new Date("2026-11-23T12:00:00Z"),
    ...extra,
  });
  return { a, urls: f.calls.map((c) => c.url) };
}

function row(a: Assessment, id: string): CheckRow {
  const r = a.checks.find((c) => c.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

const codes = (r: CheckRow) => r.reasons.map((x) => x.code);

function pull(number: number, mergedAt: string | null, updatedAt: string, author = "alice") {
  return {
    number,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    user: { login: author, type: "User" },
    merged_at: mergedAt,
    updated_at: updatedAt,
    base: { ref: "main" },
  };
}

const page = (n: number) => `${PULLS_PATH}&page=${n}`;
const numbers = (r: CheckRow) => (r.details?.pullRequests as Array<{ number: number }>).map((p) => p.number);

describe("check 6 reads until no later merge can be missing", () => {
  // Page 1: number 1, merged in January but commented on today, then number 10,
  // merged on the 19th. Page 2: number 9, merged on the 18th. Page 3: number 8,
  // merged on the 1st. Page 4: older still.
  function staleFirst(): Fixture {
    const fx = goodFixture();
    fx.pulls = [
      { number: 10, author: "coder-agent", files: [["src/a.ts"]] },
      { number: 9, author: "coder-agent", files: [["src/b.ts"]] },
      { number: 1, author: "coder-agent", files: [["src/c.ts"]] },
      { number: 8, author: "coder-agent", files: [["src/d.ts"]] },
    ];
    fx.extra = paged(PULLS_PATH, [
      [pull(1, "2026-01-05T12:00:00Z", "2026-11-20T12:00:00Z", "coder-agent"), pull(10, "2026-11-19T12:00:00Z", "2026-11-19T12:00:00Z", "coder-agent")],
      [pull(9, "2026-11-18T12:00:00Z", "2026-11-18T12:00:00Z", "coder-agent")],
      [pull(8, "2026-11-01T12:00:00Z", "2026-11-01T12:00:00Z", "coder-agent")],
      [pull(7, "2026-10-01T12:00:00Z", "2026-10-01T12:00:00Z", "coder-agent")],
    ]);
    return fx;
  }

  it("a pull request merged long ago but updated recently does not take a recent merge's place", async () => {
    const { a } = await run(staleFirst(), { merges: 2 });
    const r = row(a, "agent_merges_touching_gates");
    expect(r.status).toBe("context");
    expect(numbers(r)).toEqual([10, 9]);
    expect(r.details).toMatchObject({ requested: 2, mergedRead: 2, agentMerges: 2 });
  });

  it("stops once the oldest update read is older than the Nth merge, and lists every page read", async () => {
    const { a, urls } = await run(staleFirst(), { merges: 2 });
    const r = row(a, "agent_merges_touching_gates");
    // After page 2 the oldest update (the 18th) equals the 2nd merge, so a merge on
    // the 18th could still be unread; page 3's oldest update (the 1st) settles it.
    expect(urls.filter((u) => u.includes("/pulls?"))).toHaveLength(3);
    expect(urls.some((u) => u.endsWith("&page=4"))).toBe(false);
    for (const p of [`GET ${PULLS_PATH}`, `GET ${page(2)}`, `GET ${page(3)}`]) expect(r.read).toContain(p);
    expect(r.read).not.toContain(`GET ${page(4)}`);
    expect(a.reads.find((x) => x.endpoint === `GET ${PULLS_PATH}`)?.pages).toBe(3);
  });

  it("does not read a second page when the first already settles the set", async () => {
    const fx = goodFixture();
    fx.extra = paged(PULLS_PATH, [
      [pull(7, "2026-11-17T12:00:00Z", "2026-11-17T12:00:00Z", "coder-agent"), pull(6, "2026-11-16T12:00:00Z", "2026-11-16T12:00:00Z")],
      [pull(5, "2026-11-15T12:00:00Z", "2026-11-15T12:00:00Z")],
    ]);
    const { a, urls } = await run(fx, { merges: 1 });
    expect(urls.filter((u) => u.includes("/pulls?"))).toHaveLength(1);
    expect(row(a, "agent_merges_touching_gates").status).toBe("context");
  });

  it("at the page cap the set may be incomplete: unverifiable with merges_incomplete, and no page past the cap is read", async () => {
    // Every pull request was merged in the past but updated recently, so the
    // oldest update never drops below the newest merge.
    const cap = 1 + MERGE_EXTRA_PAGES;
    const pages = Array.from({ length: cap + 2 }, (_, i) => [
      pull(500 - i, `2026-0${1 + (i % 9)}-01T12:00:00Z`, `2026-11-22T${String(23 - (i % 24)).padStart(2, "0")}:00:00Z`),
    ]);
    const fx = goodFixture();
    fx.extra = paged(PULLS_PATH, pages);
    const { a, urls } = await run(fx, { merges: 1 });
    const r = row(a, "agent_merges_touching_gates");
    expect(urls.filter((u) => u.includes("/pulls?"))).toHaveLength(cap);
    expect(r.status).toBe("unverifiable");
    expect(codes(r)).toEqual(["merges_incomplete"]);
    expect(r.reasons[0]?.subjects).toEqual([`${cap} pages read, the cap for 1 merged pull request`]);
    expect(r.read).toContain(`GET ${page(cap)}`);
    expect(r.read).not.toContain(`GET ${page(cap + 1)}`);
    // What was read is still given.
    expect(r.details).toMatchObject({ requested: 1, mergedRead: 1, agentMerges: 0 });
  });

  it("a list that ends before the condition holds is complete", async () => {
    const fx = goodFixture();
    fx.extra = paged(PULLS_PATH, [
      [pull(1, "2026-01-05T12:00:00Z", "2026-11-20T12:00:00Z"), pull(7, "2026-11-17T12:00:00Z", "2026-11-17T12:00:00Z", "coder-agent")],
    ]);
    const { a } = await run(fx, { merges: 1 });
    const r = row(a, "agent_merges_touching_gates");
    expect(r.status).toBe("context");
    expect(numbers(r)).toEqual([7]);
  });
});

describe("GitHubClient.getAll: a page cap and the pages read", () => {
  it("stops at the cap with the items read so far, marked capped, and names each page", async () => {
    const routes = paged("/repos/o/r/pulls?state=closed", [[{ n: 1 }], [{ n: 2 }], [{ n: 3 }]]);
    const f = fakeFetch(routes);
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.getAll("/repos/o/r/pulls?state=closed", "content", undefined, 2);
    expect(r.state).toBe("read");
    expect(r.data).toEqual([{ n: 1 }, { n: 2 }]);
    expect(r.capped).toBe(true);
    expect(r.pageEndpoints).toEqual(["/repos/o/r/pulls?state=closed", "/repos/o/r/pulls?state=closed&page=2"]);
    expect(f.calls).toHaveLength(2);
  });

  it("a list that ends at the cap is not capped", async () => {
    const routes = paged("/repos/o/r/pulls?state=closed", [[{ n: 1 }], [{ n: 2 }]]);
    const client = new GitHubClient({ fetch: fakeFetch(routes).fetch });
    const r = await client.getAll("/repos/o/r/pulls?state=closed", "content", undefined, 2);
    expect(r.capped).toBeUndefined();
    expect(r.data).toHaveLength(2);
  });
});
