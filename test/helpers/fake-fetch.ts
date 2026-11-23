// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

export const API = "https://api.github.com";

export interface FakeResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export type Routes = Record<string, FakeResponse>;

/**
 * A fetch stand-in that answers from hand-written fixtures shaped like
 * GitHub's responses. Keys are paths with their query string, relative to
 * the API origin. Unknown paths answer 404 so a missing fixture is visible.
 */
export function fakeFetch(routes: Routes, apiUrl = API) {
  const calls: FakeCall[] = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string> }) => {
    calls.push({ url, method: init.method, headers: { ...init.headers } });
    const key = url.startsWith(apiUrl) ? url.slice(apiUrl.length) : url;
    const route = routes[key];
    const res: FakeResponse = route ?? { status: 404, body: { message: "Not Found" } };
    const headers = new Map<string, string>(
      Object.entries(res.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      status: res.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => (res.body === undefined ? "" : JSON.stringify(res.body)),
    };
  };
  return { fetch: fn, calls };
}

export function ok(body: unknown, headers?: Record<string, string>): FakeResponse {
  return headers ? { status: 200, body, headers } : { status: 200, body };
}

/** Split a list over pages joined by Link headers, as GitHub does. */
export function paged(path: string, pages: unknown[][], apiUrl = API): Routes {
  const sep = path.includes("?") ? "&" : "?";
  const routes: Routes = {};
  pages.forEach((items, i) => {
    const key = i === 0 ? path : `${path}${sep}page=${i + 1}`;
    const headers: Record<string, string> = {};
    if (i < pages.length - 1) {
      const next = `${apiUrl}${path}${sep}page=${i + 2}`;
      const last = `${apiUrl}${path}${sep}page=${pages.length}`;
      headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
    }
    routes[key] = { status: 200, body: items, headers };
  });
  return routes;
}
