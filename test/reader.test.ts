// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github/client.js";
import { API, fakeFetch, ok, paged } from "./helpers/fake-fetch.js";

describe("GitHubClient: read-only", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post", "delete"]) {
    it(`refuses ${method} and never calls the network`, async () => {
      const f = fakeFetch({ "/x": ok({}) });
      const client = new GitHubClient({ fetch: f.fetch });
      await expect(client.request(method, "/x")).rejects.toThrow(/read-only/);
      expect(f.calls).toHaveLength(0);
    });
  }

  it("sends GET only", async () => {
    const f = fakeFetch({ "/repos/o/r": ok({ full_name: "o/r" }) });
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.get("/repos/o/r");
    expect(r.state).toBe("read");
    expect(f.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("defaults the API URL to https://api.github.com", async () => {
    const f = fakeFetch({ "/repos/o/r": ok({}) });
    const client = new GitHubClient({ fetch: f.fetch });
    await client.get("/repos/o/r");
    expect(f.calls[0]?.url).toBe(`${API}/repos/o/r`);
  });

  it("uses the token for auth but never puts it in an endpoint or the read log", async () => {
    const token = "ghp_SENTINEL_never_print_0123456789";
    const f = fakeFetch({ "/repos/o/r": ok({}) });
    const client = new GitHubClient({ fetch: f.fetch, token });
    const r = await client.get("/repos/o/r");
    expect(f.calls[0]?.headers.authorization).toBe(`Bearer ${token}`);
    expect(JSON.stringify(r)).not.toContain(token);
    expect(JSON.stringify(client.log())).not.toContain(token);
  });
});

describe("GitHubClient: pagination", () => {
  it("reads a list split over three pages by Link headers to its last page", async () => {
    const routes = paged("/repos/o/r/collaborators?per_page=100", [
      [{ login: "a" }, { login: "b" }],
      [{ login: "c" }],
      [{ login: "d" }],
    ]);
    const f = fakeFetch(routes);
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.getAll("/repos/o/r/collaborators?per_page=100", "settings");
    expect(r.state).toBe("read");
    expect((r.data as Array<{ login: string }>).map((x) => x.login)).toEqual(["a", "b", "c", "d"]);
    expect(r.pages).toBe(3);
    expect(f.calls).toHaveLength(3);
  });

  it("a failed later page makes the whole list unread, never a partial inventory", async () => {
    const routes = paged("/repos/o/r/collaborators?per_page=100", [[{ login: "a" }], [{ login: "b" }]]);
    routes["/repos/o/r/collaborators?per_page=100&page=2"] = { status: 502, body: {} };
    const client = new GitHubClient({ fetch: fakeFetch(routes).fetch });
    const r = await client.getAll("/repos/o/r/collaborators?per_page=100", "settings");
    expect(r.state).toBe("error");
    expect(r.data).toBeUndefined();
  });

  it("never follows a Link to a host other than the configured API URL", async () => {
    const f = fakeFetch({
      "/repos/o/r/collaborators?per_page=100": ok([{ login: "a" }], {
        link: '<https://evil.example/repos/o/r/collaborators?page=2>; rel="next"',
      }),
    });
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.getAll("/repos/o/r/collaborators?per_page=100", "settings");
    expect(r.state).toBe("error");
    expect(f.calls.every((c) => c.url.startsWith(API))).toBe(true);
    expect(f.calls).toHaveLength(1);
  });

  it("can stop early once the caller has enough, recording the pages read", async () => {
    const routes = paged("/repos/o/r/pulls?state=closed", [[{ n: 1 }], [{ n: 2 }], [{ n: 3 }]]);
    const f = fakeFetch(routes);
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.getAll("/repos/o/r/pulls?state=closed", "content", (items) => items.length >= 2);
    expect(r.state).toBe("read");
    expect((r.data as unknown[]).length).toBe(2);
    expect(r.pages).toBe(2);
  });
});

describe("GitHubClient: read states by status code and fields, never by message wording", () => {
  const cases: Array<[string, number, Record<string, string>, "content" | "settings" | "file", string]> = [
    ["401 is not_permitted", 401, {}, "settings", "not_permitted"],
    ["403 is not_permitted", 403, {}, "settings", "not_permitted"],
    ["404 on a settings endpoint is not_permitted", 404, {}, "settings", "not_permitted"],
    ["404 on a content endpoint is error", 404, {}, "content", "error"],
    ["500 is error", 500, {}, "settings", "error"],
    ["403 with x-ratelimit-remaining 0 is error (rate limit, not permission)", 403, { "x-ratelimit-remaining": "0" }, "settings", "error"],
    ["429 is error", 429, {}, "settings", "error"],
    ["403 with retry-after is error (secondary rate limit, not permission)", 403, { "retry-after": "60" }, "settings", "error"],
  ];
  for (const [name, status, headers, kind, expected] of cases) {
    it(name, async () => {
      const f = fakeFetch({ "/p": { status, headers, body: { message: "Resource not accessible by integration" } } });
      const client = new GitHubClient({ fetch: f.fetch });
      const r = await client.get("/p", kind);
      expect(r.state).toBe(expected);
      expect(r.status).toBe(status);
    });
  }

  it("a 403 with retry-after is recorded as rate_limited", async () => {
    const f = fakeFetch({ "/p": { status: 403, headers: { "retry-after": "60" }, body: { message: "You have exceeded a secondary rate limit" } } });
    const r = await new GitHubClient({ fetch: f.fetch }).get("/p", "settings");
    expect(r.errorKind).toBe("rate_limited");
  });

  it("the same status gives the same state whatever the message says", async () => {
    const a = new GitHubClient({ fetch: fakeFetch({ "/p": { status: 403, body: { message: "Must have admin rights" } } }).fetch });
    const b = new GitHubClient({ fetch: fakeFetch({ "/p": { status: 403, body: { message: "something else entirely" } } }).fetch });
    expect((await a.get("/p", "settings")).state).toBe((await b.get("/p", "settings")).state);
  });

  it("a 404 on a file probe is a read that found no file", async () => {
    const client = new GitHubClient({ fetch: fakeFetch({}).fetch });
    const r = await client.get("/repos/o/r/contents/CODEOWNERS?ref=abc", "file");
    expect(r.state).toBe("read");
    expect(r.absent).toBe(true);
  });

  it("a network failure is error", async () => {
    const client = new GitHubClient({
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const r = await client.get("/p");
    expect(r.state).toBe("error");
    expect(r.status).toBeNull();
  });
});

describe("GitHubClient: concurrency", () => {
  it("never has more requests in flight than its cap, and answers each", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch = async (url: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ url }) };
    };
    const client = new GitHubClient({ fetch, concurrency: 3 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => client.get<{ url: string }>(`/x/${i}`)));
    expect(peak).toBe(3);
    expect(results.map((r) => r.data?.url)).toEqual(Array.from({ length: 20 }, (_, i) => `${API}/x/${i}`));
    expect(client.log()).toHaveLength(20);
  });
});

describe("GitHubClient: a list wrapped in an object", () => {
  it("reads the named array from every page", async () => {
    const path = "/orgs/o/installations?per_page=100";
    const f = fakeFetch({
      [path]: ok({ total_count: 2, installations: [{ id: 1 }] }, { link: `<${API}${path}&page=2>; rel="next"` }),
      [`${path}&page=2`]: ok({ total_count: 2, installations: [{ id: 2 }] }),
    });
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.getAll<{ id: number }>(path, "settings", undefined, undefined, "installations");
    expect(r.state).toBe("read");
    expect(r.data?.map((x) => x.id)).toEqual([1, 2]);
    expect(r.pages).toBe(2);
  });

  it("a page without the named array is an error, not an empty list", async () => {
    const path = "/orgs/o/installations?per_page=100";
    const client = new GitHubClient({ fetch: fakeFetch({ [path]: ok({ total_count: 0 }) }).fetch });
    const r = await client.getAll(path, "settings", undefined, undefined, "installations");
    expect(r.state).toBe("error");
    expect(r.errorKind).toBe("not_a_list");
  });
});
