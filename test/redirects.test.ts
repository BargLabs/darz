// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// GitHub answers a read of a renamed or transferred repository with
// a 301 to /repositories/{id}/... on the same API host (seen live for
// vuejs/vue-next, now vuejs/core). Darz follows a redirect only when its
// Location is on the API URL's origin and under its path, for a few hops, and
// the record lists each URL it fetched with the status that URL answered.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { GitHubClient } from "../src/github/client.js";
import { REPO, fixtureFetch, goodFixture } from "./fixtures/github.js";
import { API, fakeFetch, ok, type FakeResponse } from "./helpers/fake-fetch.js";
import { recordErrors } from "./helpers/schemas.js";

/** The client's hop limit. A change to it should be deliberate, so it is not imported. */
const MAX_REDIRECTS = 3;

const moved = (location: string, status = 301): FakeResponse => ({
  status,
  body: { message: "Moved Permanently", url: location },
  headers: { location },
});

describe("GitHubClient: redirects", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`follows a ${status} to the same API host and records both URLs`, async () => {
      const f = fakeFetch({
        "/repos/o/old": moved(`${API}/repositories/42`, status),
        "/repositories/42": ok({ full_name: "o/new" }),
      });
      const client = new GitHubClient({ fetch: f.fetch, token: "t" });
      const r = await client.get<{ full_name: string }>("/repos/o/old");
      expect(r.state).toBe("read");
      expect(r.status).toBe(200);
      expect(r.data?.full_name).toBe("o/new");
      expect(r.endpoint).toBe("/repos/o/old");
      expect(f.calls.map((c) => c.url)).toEqual([`${API}/repos/o/old`, `${API}/repositories/42`]);
      expect(f.calls[1]?.headers.authorization).toBe("Bearer t");
      expect(client.log()).toEqual([
        { endpoint: "/repos/o/old", state: "read", status },
        { endpoint: "/repositories/42", state: "read", status: 200 },
      ]);
    });
  }

  it("keeps the query string and resolves a relative Location", async () => {
    const f = fakeFetch({
      "/repos/o/old/git/trees/main?recursive=1": moved("/repositories/42/git/trees/main?recursive=1"),
      "/repositories/42/git/trees/main?recursive=1": ok({ sha: "abc", tree: [] }),
    });
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.get("/repos/o/old/git/trees/main?recursive=1");
    expect(r.state).toBe("read");
    expect(client.log().map((e) => e.endpoint)).toEqual([
      "/repos/o/old/git/trees/main?recursive=1",
      "/repositories/42/git/trees/main?recursive=1",
    ]);
  });

  it("the followed read ends as the target answers: a 404 on a file probe is absent", async () => {
    const f = fakeFetch({ "/repos/o/old/contents/CODEOWNERS": moved(`${API}/repositories/42/contents/CODEOWNERS`) });
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.get("/repos/o/old/contents/CODEOWNERS", "file");
    expect(r).toMatchObject({ state: "read", status: 404, absent: true });
    expect(client.log()).toEqual([
      { endpoint: "/repos/o/old/contents/CODEOWNERS", state: "read", status: 301, absent: true },
      { endpoint: "/repositories/42/contents/CODEOWNERS", state: "read", status: 404, absent: true },
    ]);
  });

  it("the followed read ends as the target answers: a 403 is not_permitted", async () => {
    const f = fakeFetch({
      "/repos/o/old/collaborators": moved(`${API}/repositories/42/collaborators`),
      "/repositories/42/collaborators": { status: 403, body: { message: "Must have push access" } },
    });
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.get("/repos/o/old/collaborators", "settings");
    expect(r).toMatchObject({ state: "not_permitted", status: 403 });
    expect(client.log().map((e) => [e.endpoint, e.state, e.status])).toEqual([
      ["/repos/o/old/collaborators", "not_permitted", 301],
      ["/repositories/42/collaborators", "not_permitted", 403],
    ]);
  });

  const refused: Array<[string, string, string?]> = [
    ["another host", "https://evil.example/repositories/42"],
    ["a subdomain of the API host", "https://x.api.github.com/repositories/42"],
    ["plain http", "http://api.github.com/repositories/42"],
    ["another port", "https://api.github.com:8443/repositories/42"],
    ["credentials in the URL", "https://user:pw@api.github.com/repositories/42"],
    ["a host that only starts like the API host", "https://api.github.com.evil.example/repositories/42"],
    ["a protocol-relative URL to another host", "//evil.example/repositories/42"],
    ["a path outside the GHES API path", "https://ghe.example/other/repositories/42", "https://ghe.example/api/v3"],
    ["a path that climbs out of the GHES API path", "/api/v3/../../other", "https://ghe.example/api/v3"],
    ["a sibling of the GHES API path", "https://ghe.example/api/v30/repositories/42", "https://ghe.example/api/v3"],
  ];
  for (const [what, location, apiUrl] of refused) {
    it(`does not follow a redirect to ${what}, and never calls it`, async () => {
      const base = apiUrl ?? API;
      const f = fakeFetch({ "/repos/o/old": moved(location) }, base);
      const client = new GitHubClient({ fetch: f.fetch, apiUrl: base });
      const r = await client.get("/repos/o/old");
      expect(r).toMatchObject({ state: "error", status: 301, errorKind: "foreign_redirect" });
      expect(f.calls).toHaveLength(1);
      expect(client.log()).toEqual([{ endpoint: "/repos/o/old", state: "error", status: 301, errorKind: "foreign_redirect" }]);
    });
  }

  it("follows a redirect within the GHES API path", async () => {
    const ghes = "https://ghe.example/api/v3";
    const f = fakeFetch({ "/repos/o/old": moved("/api/v3/repositories/42"), "/repositories/42": ok({}) }, ghes);
    const client = new GitHubClient({ fetch: f.fetch, apiUrl: ghes });
    expect((await client.get("/repos/o/old")).state).toBe("read");
    expect(f.calls.map((c) => c.url)).toEqual([`${ghes}/repos/o/old`, `${ghes}/repositories/42`]);
  });

  it("a redirect without a Location is an error", async () => {
    const f = fakeFetch({ "/repos/o/old": { status: 301, body: {} } });
    const client = new GitHubClient({ fetch: f.fetch });
    expect(await client.get("/repos/o/old")).toMatchObject({ state: "error", status: 301, errorKind: "redirect_without_location" });
  });

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    const routes: Record<string, FakeResponse> = {};
    for (let i = 0; i <= MAX_REDIRECTS + 1; i++) routes[`/hop/${i}`] = moved(`${API}/hop/${i + 1}`);
    const f = fakeFetch(routes);
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.get("/hop/0");
    expect(r).toMatchObject({ state: "error", status: 301, errorKind: "redirect_limit" });
    expect(f.calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("does not follow a 300 or a 304", async () => {
    for (const status of [300, 304]) {
      const f = fakeFetch({ "/x": moved(`${API}/y`, status), "/y": ok({}) });
      const client = new GitHubClient({ fetch: f.fetch });
      expect(await client.get("/x")).toMatchObject({ state: "error", status, errorKind: "http_status" });
      expect(f.calls).toHaveLength(1);
    }
  });

  it("follows a redirected first page and then the Link pages", async () => {
    const f = fakeFetch({
      "/repos/o/old/collaborators?per_page=100": moved(`${API}/repositories/42/collaborators?per_page=100`),
      "/repositories/42/collaborators?per_page=100": {
        status: 200,
        body: [{ login: "a" }],
        headers: { link: `<${API}/repositories/42/collaborators?per_page=100&page=2>; rel="next"` },
      },
      "/repositories/42/collaborators?per_page=100&page=2": ok([{ login: "b" }]),
    });
    const client = new GitHubClient({ fetch: f.fetch });
    const r = await client.getAll<{ login: string }>("/repos/o/old/collaborators?per_page=100", "settings");
    expect(r.state).toBe("read");
    expect(r.data?.map((x) => x.login)).toEqual(["a", "b"]);
    expect(r.pages).toBe(2);
    expect(client.log()).toEqual([
      { endpoint: "/repos/o/old/collaborators?per_page=100", state: "read", status: 301, pages: 2 },
      { endpoint: "/repositories/42/collaborators?per_page=100", state: "read", status: 200 },
    ]);
  });
});

describe("CLI: a renamed repository", () => {
  // The fixture's repository answers under /repositories/42; its old name
  // answers 301 there, as GitHub does after a rename.
  const OLD = "acme/old-widget";
  function renamedFetch() {
    const inner = fixtureFetch(goodFixture()).fetch;
    const calls: string[] = [];
    const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
      calls.push(url);
      const oldPrefix = `${API}/repos/${OLD}`;
      if (url === oldPrefix || url.startsWith(`${oldPrefix}/`) || url.startsWith(`${oldPrefix}?`)) {
        const location = `${API}/repositories/42${url.slice(oldPrefix.length)}`;
        return { status: 301, headers: { get: (n: string) => (n.toLowerCase() === "location" ? location : null) }, text: async () => "{}" };
      }
      const prefix = `${API}/repositories/42`;
      if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
        return inner(`${API}/repos/${REPO}${url.slice(prefix.length)}`, init);
      }
      return inner(url, init);
    };
    return { fetch, calls };
  }

  it("reads it through the redirect, instead of exit 3, and records each redirect", async () => {
    const out = mkdtempSync(join(tmpdir(), "darz-test-"));
    const f = renamedFetch();
    const code = await main(["--out", out, OLD, "--agent", "coder-agent"], {
      env: { GITHUB_TOKEN: "ghp_DARZ_REDIRECT_TEST_TOKEN_0123456789" },
      fetch: f.fetch,
      stdout: () => {},
      stderr: () => {},
      now: () => new Date("2026-11-20T12:00:00Z"),
    });
    expect(code).toBe(0);
    const record = JSON.parse(readFileSync(join(out, "darz-record.json"), "utf8"));
    expect(recordErrors(record)).toEqual([]);
    expect(record.repository).toBe(OLD);
    const reads = record.reads as Array<{ endpoint: string; state: string; status: number }>;
    expect(reads).toContainEqual({ endpoint: `GET /repos/${OLD}`, state: "read", status: 301 });
    expect(reads).toContainEqual({ endpoint: "GET /repositories/42", state: "read", status: 200 });
    // Every read of the old name was redirected and has its target beside it.
    const old = reads.filter((e) => e.endpoint.startsWith(`GET /repos/${OLD}`));
    expect(old.length).toBeGreaterThan(5);
    for (const e of old) {
      expect(e.status).toBe(301);
      expect(reads.some((t) => t.endpoint === e.endpoint.replace(`/repos/${OLD}`, "/repositories/42"))).toBe(true);
    }
    // No host other than the API URL was called.
    expect(f.calls.every((u) => u.startsWith(`${API}/`))).toBe(true);
  });
});
