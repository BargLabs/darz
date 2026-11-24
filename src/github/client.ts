// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

/**
 * A read-only GitHub REST client.
 *
 * - GET is the only method. Any other method throws before the network is touched.
 * - Only the configured API URL is ever called, including when following Link
 *   headers and redirects. A redirect is followed only to the API URL's own
 *   origin and path, at most {@link MAX_REDIRECTS} times per read.
 * - The token is sent as a header and is never stored in a result, an endpoint or the log.
 * - Every result ends in one of three states, decided by status code and
 *   response fields, never by the wording of an error message. A 401 or 403
 *   that carries `retry-after` or `x-ratelimit-remaining: 0` is a rate limit
 *   (`error`), not a permission answer.
 */

export type ReadState = "read" | "not_permitted" | "error";

/**
 * How a 404 is read:
 * - `content`: the thing should exist on a readable repository; 404 is `error`.
 * - `settings`: a settings endpoint; on a readable repository 404 means the
 *   token may not see it, so 404 is `not_permitted`.
 * - `file`: a probe for a file that may legitimately be absent; 404 is a `read`
 *   with `absent: true`.
 */
export type EndpointKind = "content" | "settings" | "file";

export interface ReadResult<T = unknown> {
  endpoint: string;
  state: ReadState;
  status: number | null;
  data?: T;
  absent?: boolean;
  pages?: number;
  errorKind?: string;
  /**
   * For a list read by `getAll` that stopped at the caller's page cap with
   * more pages left: the items are those read so far, not the whole list.
   */
  capped?: true;
  /** For a list read by `getAll`: the endpoint of each page read, in order. */
  pageEndpoints?: string[];
  /**
   * The scopes a classic OAuth or personal access token carries, from the
   * x-oauth-scopes response header. Absent when the header is (fine-grained
   * and GitHub App tokens send none).
   */
  oauthScopes?: string[];
}

export interface ReadLogEntry {
  endpoint: string;
  state: ReadState;
  status: number | null;
  pages?: number;
  absent?: boolean;
  errorKind?: string;
  /** A GraphQL read whose data came back with errors on some parts; those parts were not used. */
  partial?: true;
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export interface GitHubClientOptions {
  fetch: FetchLike;
  apiUrl?: string;
  token?: string;
  userAgent?: string;
  maxPages?: number;
  /** Requests in flight at once (default {@link DEFAULT_CONCURRENCY}). */
  concurrency?: number;
}

export const DEFAULT_API_URL = "https://api.github.com";

/**
 * Redirects followed per request. GitHub answers a read of a renamed or
 * transferred repository with one 301 to `/repositories/{id}/...`.
 */
export const MAX_REDIRECTS = 3;

/** Statuses whose `Location` is followed, as a GET. 300 and 304 are not redirects to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** One URL fetched while following redirects: its path under the API URL and the status it answered. */
interface Hop {
  endpoint: string;
  status: number | null;
}

/**
 * Requests in flight at once. GitHub's secondary rate limits penalise bursts of
 * concurrent requests, so this stays small; a throttled read is an `error`,
 * which makes a check unverifiable rather than wrong.
 */
export const DEFAULT_CONCURRENCY = 4;

/**
 * A response that is a rate limit or a permission answer, decided the same way
 * for every reader: 429, or a 401 or 403 carrying `retry-after` or
 * `x-ratelimit-remaining: 0`, is a rate limit; any other 401 or 403 is
 * `not_permitted`. Null for every other status.
 */
export function deniedState(
  res: FetchResponseLike,
): { state: "not_permitted" } | { state: "error"; errorKind: "rate_limited" } | null {
  const status = res.status;
  const throttled = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null;
  if (status === 429 || ((status === 403 || status === 401) && throttled)) return { state: "error", errorKind: "rate_limited" };
  if (status === 401 || status === 403) return { state: "not_permitted" };
  return null;
}

export class ReadOnlyViolation extends Error {
  constructor(method: string) {
    super(`darz is read-only: refused ${method.toUpperCase()}; only GET is allowed`);
    this.name = "ReadOnlyViolation";
  }
}

export class GitHubClient {
  readonly apiUrl: string;
  readonly #fetch: FetchLike;
  readonly #token: string | undefined;
  readonly #userAgent: string;
  readonly #maxPages: number;
  readonly #log: ReadLogEntry[] = [];
  readonly #concurrency: number;
  #inFlight = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(opts: GitHubClientOptions) {
    this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.#fetch = opts.fetch;
    this.#token = opts.token && opts.token.length > 0 ? opts.token : undefined;
    this.#userAgent = opts.userAgent ?? "darz";
    this.#maxPages = opts.maxPages ?? 1000;
    this.#concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  }

  async #acquire(): Promise<void> {
    if (this.#inFlight < this.#concurrency) {
      this.#inFlight += 1;
      return;
    }
    // The slot is handed over by #release, so #inFlight is not incremented here.
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#inFlight -= 1;
  }

  /** Every endpoint read so far, without response bodies. */
  log(): ReadLogEntry[] {
    return this.#log.map((e) => ({ ...e }));
  }

  /** The one entry point to the network. Throws on any method other than GET. */
  async request(method: string, path: string, kind: EndpointKind = "content"): Promise<ReadResult> {
    if (method.toUpperCase() !== "GET") {
      throw new ReadOnlyViolation(method);
    }
    const { result, hops } = await this.#getUrl(this.#urlFor(path), path, kind);
    return this.#record(result, hops);
  }

  async get<T = unknown>(path: string, kind: EndpointKind = "content"): Promise<ReadResult<T>> {
    return (await this.request("GET", path, kind)) as ReadResult<T>;
  }

  /**
   * Read a list to its last page by following `Link: rel="next"`. A failure on
   * any page makes the whole list unread: a first page is not an inventory.
   * `enough`, if given, stops early once the caller has what it asked for.
   * `pageCap`, if given, stops after that many pages even if more are left:
   * the result is `read` with the items so far and `capped: true`, so the
   * caller can say the list may be incomplete.
   * `itemsKey`, if given, names the array in each page's object, for lists
   * GitHub wraps (`{ "total_count": 2, "installations": [...] }`).
   */
  async getAll<T = unknown>(
    path: string,
    kind: EndpointKind = "content",
    enough?: (items: T[]) => boolean,
    pageCap?: number,
    itemsKey?: string,
  ): Promise<ReadResult<T[]>> {
    const items: T[] = [];
    let url: string | null = this.#urlFor(path);
    let pages = 0;
    const pageEndpoints: string[] = [];
    // The first page's hops start with the requested path; a later page's
    // hops (rare) add only the URLs it was redirected to.
    const hops: Hop[] = [];
    while (url !== null) {
      if (pages >= this.#maxPages) {
        return this.#record({ endpoint: path, state: "error", status: null, pages, errorKind: "page_limit" }, hops);
      }
      const got = await this.#getUrl(url, path, kind);
      const { result, next } = got;
      hops.push(...(pages === 0 ? got.hops : got.hops.slice(1)));
      pages += 1;
      pageEndpoints.push(url.slice(this.apiUrl.length));
      if (result.state !== "read") {
        return this.#record({ ...stripData(result), endpoint: path, pages }, hops) as ReadResult<T[]>;
      }
      if (result.absent) {
        return this.#record({ endpoint: path, state: "read", status: result.status, absent: true, pages }, hops);
      }
      const list =
        itemsKey === undefined
          ? result.data
          : typeof result.data === "object" && result.data !== null
            ? (result.data as Record<string, unknown>)[itemsKey]
            : undefined;
      if (!Array.isArray(list)) {
        return this.#record({ endpoint: path, state: "error", status: result.status, pages, errorKind: "not_a_list" }, hops);
      }
      items.push(...(list as T[]));
      if (enough?.(items)) break;
      if (next !== null && !this.#isOwnUrl(next)) {
        return this.#record({ endpoint: path, state: "error", status: result.status, pages, errorKind: "foreign_link" }, hops);
      }
      if (next !== null && pageCap !== undefined && pages >= pageCap) {
        const capped: ReadResult<T[]> = { endpoint: path, state: "read", status: 200, data: items, pages, capped: true, pageEndpoints };
        this.#record(capped, hops);
        return capped;
      }
      url = next;
    }
    const final: ReadResult<T[]> = { endpoint: path, state: "read", status: 200, data: items, pages, pageEndpoints };
    this.#record(final, hops);
    return final;
  }

  #urlFor(path: string): string {
    if (!path.startsWith("/")) throw new Error(`endpoint path must start with "/": ${path}`);
    return `${this.apiUrl}${path}`;
  }

  #isOwnUrl(url: string): boolean {
    return url === this.apiUrl || url.startsWith(`${this.apiUrl}/`) || url.startsWith(`${this.apiUrl}?`);
  }

  /**
   * Log one read. A read that followed redirects gets one more entry per URL
   * a redirect sent it to (`hops` after the first). Each entry carries the
   * status that URL answered, and all carry how the read ended. The requested
   * path's entry keeps the page count, so a check's `read` list still points
   * at an entry that says whether the read succeeded.
   */
  #record<T>(result: ReadResult<T>, hops: Hop[] = []): ReadResult<T> {
    const redirected = hops.length > 1;
    const entry: ReadLogEntry = {
      endpoint: result.endpoint,
      state: result.state,
      status: redirected ? (hops[0]?.status ?? null) : result.status,
    };
    if (result.pages !== undefined) entry.pages = result.pages;
    if (result.absent) entry.absent = true;
    if (result.errorKind !== undefined) entry.errorKind = result.errorKind;
    this.#log.push(entry);
    if (redirected) {
      for (const hop of hops.slice(1)) {
        const e: ReadLogEntry = { endpoint: hop.endpoint, state: result.state, status: hop.status };
        if (result.absent) e.absent = true;
        if (result.errorKind !== undefined) e.errorKind = result.errorKind;
        this.#log.push(e);
      }
    }
    return result;
  }

  /**
   * The absolute URL a redirect's `Location` names, if it is on the API URL's
   * origin (scheme, host and port), carries no credentials, and lies under the
   * API URL's path; otherwise null. Relative locations resolve against the URL
   * that answered. The result is rebuilt on the configured API URL, so it is
   * an own URL by the same test every other request passes.
   */
  #ownRedirect(location: string, from: string): string | null {
    let target: URL;
    let api: URL;
    try {
      target = new URL(location, from);
      api = new URL(this.apiUrl);
    } catch {
      return null;
    }
    if (target.origin !== api.origin || target.username !== "" || target.password !== "") return null;
    const base = api.pathname.replace(/\/+$/, "");
    if (target.pathname !== base && !target.pathname.startsWith(`${base}/`)) return null;
    const rest = target.pathname.slice(base.length) || "/";
    return `${this.apiUrl}${rest}${target.search}`;
  }

  /** The path under the API URL that an own URL names. */
  #pathOf(url: string): string {
    return url.slice(this.apiUrl.length) || "/";
  }

  async #getUrl(
    url: string,
    endpoint: string,
    kind: EndpointKind,
  ): Promise<{ result: ReadResult; next: string | null; hops: Hop[] }> {
    if (!this.#isOwnUrl(url)) {
      return { result: { endpoint, state: "error", status: null, errorKind: "foreign_host" }, next: null, hops: [] };
    }
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": this.#userAgent,
    };
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;

    await this.#acquire();
    try {
      // Follow redirects to the API URL only. The token goes only to URLs
      // that pass the same own-URL test as the first request.
      const hops: Hop[] = [];
      let current = url;
      for (;;) {
        const got = await this.#fetchOne(current, endpoint, kind, headers);
        hops.push({ endpoint: this.#pathOf(current), status: got.result.status });
        if (got.location === undefined) return { result: got.result, next: got.next, hops };
        const status = got.result.status;
        const fail = (errorKind: string) => ({ result: { endpoint, state: "error" as const, status, errorKind }, next: null, hops });
        if (got.location === null) return fail("redirect_without_location");
        const target = this.#ownRedirect(got.location, current);
        if (target === null) return fail("foreign_redirect");
        if (hops.length > MAX_REDIRECTS) return fail("redirect_limit");
        current = target;
      }
    } finally {
      this.#release();
    }
  }

  async #fetchOne(
    url: string,
    endpoint: string,
    kind: EndpointKind,
    headers: Record<string, string>,
  ): Promise<{ result: ReadResult; next: string | null; location?: string | null }> {
    let res: FetchResponseLike;
    try {
      res = await this.#fetch(url, { method: "GET", headers });
    } catch {
      return { result: { endpoint, state: "error", status: null, errorKind: "network" }, next: null };
    }
    const status = res.status;

    if (status >= 200 && status < 300) {
      let data: unknown;
      try {
        const body = await res.text();
        data = body.length === 0 ? null : JSON.parse(body);
      } catch {
        return { result: { endpoint, state: "error", status, errorKind: "invalid_json" }, next: null };
      }
      const result: ReadResult = { endpoint, state: "read", status, data };
      const scopes = res.headers.get("x-oauth-scopes");
      if (scopes !== null) {
        result.oauthScopes = scopes
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      }
      return { result, next: parseNextLink(res.headers.get("link")) };
    }
    if (REDIRECT_STATUSES.has(status)) {
      // Classified by the caller, which decides whether to follow it.
      return { result: { endpoint, state: "error", status, errorKind: "http_status" }, next: null, location: res.headers.get("location") };
    }
    const denied = deniedState(res);
    if (denied) return { result: { endpoint, status, ...denied }, next: null };
    if (status === 404) {
      if (kind === "settings") return { result: { endpoint, state: "not_permitted", status }, next: null };
      if (kind === "file") return { result: { endpoint, state: "read", status, absent: true }, next: null };
      return { result: { endpoint, state: "error", status, errorKind: "not_found" }, next: null };
    }
    return { result: { endpoint, state: "error", status, errorKind: "http_status" }, next: null };
  }
}

function stripData(r: ReadResult): ReadResult {
  const { data: _data, ...rest } = r;
  return rest;
}

/** Parse the `rel="next"` target out of an RFC 8288 Link header. */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /^\s*<([^>]*)>\s*(.*)$/.exec(part);
    if (!m) continue;
    const params = m[2] ?? "";
    if (/(^|;)\s*rel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?\s*(;|$)/i.test(params)) return m[1] ?? null;
  }
  return null;
}
