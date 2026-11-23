// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

/**
 * A read-only GitHub REST client.
 *
 * - GET is the only method. Any other method throws before the network is touched.
 * - Only the configured API URL is ever called, including when following Link headers.
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
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
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
 * Requests in flight at once. GitHub's secondary rate limits penalise bursts of
 * concurrent requests, so this stays small; a throttled read is an `error`,
 * which makes a check unverifiable rather than wrong.
 */
export const DEFAULT_CONCURRENCY = 4;

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
    const { result } = await this.#getUrl(this.#urlFor(path), path, kind);
    return this.#record(result);
  }

  async get<T = unknown>(path: string, kind: EndpointKind = "content"): Promise<ReadResult<T>> {
    return (await this.request("GET", path, kind)) as ReadResult<T>;
  }

  /**
   * Read a list to its last page by following `Link: rel="next"`. A failure on
   * any page makes the whole list unread: a first page is not an inventory.
   * `enough`, if given, stops early once the caller has what it asked for.
   */
  async getAll<T = unknown>(
    path: string,
    kind: EndpointKind = "content",
    enough?: (items: T[]) => boolean,
  ): Promise<ReadResult<T[]>> {
    const items: T[] = [];
    let url: string | null = this.#urlFor(path);
    let pages = 0;
    while (url !== null) {
      if (pages >= this.#maxPages) {
        return this.#record({ endpoint: path, state: "error", status: null, pages, errorKind: "page_limit" });
      }
      const { result, next } = await this.#getUrl(url, path, kind);
      pages += 1;
      if (result.state !== "read") {
        return this.#record({ ...stripData(result), endpoint: path, pages }) as ReadResult<T[]>;
      }
      if (result.absent) {
        return this.#record({ endpoint: path, state: "read", status: result.status, absent: true, pages });
      }
      if (!Array.isArray(result.data)) {
        return this.#record({ endpoint: path, state: "error", status: result.status, pages, errorKind: "not_a_list" });
      }
      items.push(...(result.data as T[]));
      if (enough?.(items)) break;
      if (next !== null && !this.#isOwnUrl(next)) {
        return this.#record({ endpoint: path, state: "error", status: result.status, pages, errorKind: "foreign_link" });
      }
      url = next;
    }
    const final: ReadResult<T[]> = { endpoint: path, state: "read", status: 200, data: items, pages };
    this.#record(final);
    return final;
  }

  #urlFor(path: string): string {
    if (!path.startsWith("/")) throw new Error(`endpoint path must start with "/": ${path}`);
    return `${this.apiUrl}${path}`;
  }

  #isOwnUrl(url: string): boolean {
    return url === this.apiUrl || url.startsWith(`${this.apiUrl}/`) || url.startsWith(`${this.apiUrl}?`);
  }

  #record<T>(result: ReadResult<T>): ReadResult<T> {
    const entry: ReadLogEntry = { endpoint: result.endpoint, state: result.state, status: result.status };
    if (result.pages !== undefined) entry.pages = result.pages;
    if (result.absent) entry.absent = true;
    if (result.errorKind !== undefined) entry.errorKind = result.errorKind;
    this.#log.push(entry);
    return result;
  }

  async #getUrl(
    url: string,
    endpoint: string,
    kind: EndpointKind,
  ): Promise<{ result: ReadResult; next: string | null }> {
    if (!this.#isOwnUrl(url)) {
      return { result: { endpoint, state: "error", status: null, errorKind: "foreign_host" }, next: null };
    }
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": this.#userAgent,
    };
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;

    await this.#acquire();
    try {
      return await this.#fetchOne(url, endpoint, kind, headers);
    } finally {
      this.#release();
    }
  }

  async #fetchOne(
    url: string,
    endpoint: string,
    kind: EndpointKind,
    headers: Record<string, string>,
  ): Promise<{ result: ReadResult; next: string | null }> {
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
    const throttled = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null;
    if (status === 429 || ((status === 403 || status === 401) && throttled)) {
      return { result: { endpoint, state: "error", status, errorKind: "rate_limited" }, next: null };
    }
    if (status === 401 || status === 403) {
      return { result: { endpoint, state: "not_permitted", status }, next: null };
    }
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
