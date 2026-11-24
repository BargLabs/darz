// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// The CLI and the Action wrap the platform fetch. The wrapper once dropped the
// request body, so the GraphQL reader posted an empty request and every live
// read failed, while the unit tests (with a fake fetch) passed. This pins the
// wrapper itself: method, headers and body pass through, redirects are not
// followed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { platformFetch } from "../src/github/platform-fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("platformFetch", () => {
  it("passes the method, headers and body through, and does not follow redirects", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    await platformFetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"query":"query X { viewer { login } }"}',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.init.method).toBe("POST");
    expect(seen[0]?.init.body).toBe('{"query":"query X { viewer { login } }"}');
    expect(seen[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(seen[0]?.init.redirect).toBe("manual");
  });

  it("sends no body on a GET", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response("{}", { status: 200 });
    });
    await platformFetch("https://api.github.com/repos/o/r", { method: "GET", headers: {} });
    expect(seen[0]?.body).toBeUndefined();
  });
});
