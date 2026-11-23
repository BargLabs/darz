// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
export const DEFAULT_API_URL = "https://api.github.com";
/**
 * Requests in flight at once. GitHub's secondary rate limits penalise bursts of
 * concurrent requests, so this stays small; a throttled read is an `error`,
 * which makes a check unverifiable rather than wrong.
 */
export const DEFAULT_CONCURRENCY = 4;
export class ReadOnlyViolation extends Error {
    constructor(method) {
        super(`darz is read-only: refused ${method.toUpperCase()}; only GET is allowed`);
        this.name = "ReadOnlyViolation";
    }
}
export class GitHubClient {
    apiUrl;
    #fetch;
    #token;
    #userAgent;
    #maxPages;
    #log = [];
    #concurrency;
    #inFlight = 0;
    #waiting = [];
    constructor(opts) {
        this.apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
        this.#fetch = opts.fetch;
        this.#token = opts.token && opts.token.length > 0 ? opts.token : undefined;
        this.#userAgent = opts.userAgent ?? "darz";
        this.#maxPages = opts.maxPages ?? 1000;
        this.#concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
    }
    async #acquire() {
        if (this.#inFlight < this.#concurrency) {
            this.#inFlight += 1;
            return;
        }
        // The slot is handed over by #release, so #inFlight is not incremented here.
        await new Promise((resolve) => this.#waiting.push(resolve));
    }
    #release() {
        const next = this.#waiting.shift();
        if (next)
            next();
        else
            this.#inFlight -= 1;
    }
    /** Every endpoint read so far, without response bodies. */
    log() {
        return this.#log.map((e) => ({ ...e }));
    }
    /** The one entry point to the network. Throws on any method other than GET. */
    async request(method, path, kind = "content") {
        if (method.toUpperCase() !== "GET") {
            throw new ReadOnlyViolation(method);
        }
        const { result } = await this.#getUrl(this.#urlFor(path), path, kind);
        return this.#record(result);
    }
    async get(path, kind = "content") {
        return (await this.request("GET", path, kind));
    }
    /**
     * Read a list to its last page by following `Link: rel="next"`. A failure on
     * any page makes the whole list unread: a first page is not an inventory.
     * `enough`, if given, stops early once the caller has what it asked for.
     */
    async getAll(path, kind = "content", enough) {
        const items = [];
        let url = this.#urlFor(path);
        let pages = 0;
        while (url !== null) {
            if (pages >= this.#maxPages) {
                return this.#record({ endpoint: path, state: "error", status: null, pages, errorKind: "page_limit" });
            }
            const { result, next } = await this.#getUrl(url, path, kind);
            pages += 1;
            if (result.state !== "read") {
                return this.#record({ ...stripData(result), endpoint: path, pages });
            }
            if (result.absent) {
                return this.#record({ endpoint: path, state: "read", status: result.status, absent: true, pages });
            }
            if (!Array.isArray(result.data)) {
                return this.#record({ endpoint: path, state: "error", status: result.status, pages, errorKind: "not_a_list" });
            }
            items.push(...result.data);
            if (enough?.(items))
                break;
            if (next !== null && !this.#isOwnUrl(next)) {
                return this.#record({ endpoint: path, state: "error", status: result.status, pages, errorKind: "foreign_link" });
            }
            url = next;
        }
        const final = { endpoint: path, state: "read", status: 200, data: items, pages };
        this.#record(final);
        return final;
    }
    #urlFor(path) {
        if (!path.startsWith("/"))
            throw new Error(`endpoint path must start with "/": ${path}`);
        return `${this.apiUrl}${path}`;
    }
    #isOwnUrl(url) {
        return url === this.apiUrl || url.startsWith(`${this.apiUrl}/`) || url.startsWith(`${this.apiUrl}?`);
    }
    #record(result) {
        const entry = { endpoint: result.endpoint, state: result.state, status: result.status };
        if (result.pages !== undefined)
            entry.pages = result.pages;
        if (result.absent)
            entry.absent = true;
        if (result.errorKind !== undefined)
            entry.errorKind = result.errorKind;
        this.#log.push(entry);
        return result;
    }
    async #getUrl(url, endpoint, kind) {
        if (!this.#isOwnUrl(url)) {
            return { result: { endpoint, state: "error", status: null, errorKind: "foreign_host" }, next: null };
        }
        const headers = {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": this.#userAgent,
        };
        if (this.#token !== undefined)
            headers.authorization = `Bearer ${this.#token}`;
        await this.#acquire();
        try {
            return await this.#fetchOne(url, endpoint, kind, headers);
        }
        finally {
            this.#release();
        }
    }
    async #fetchOne(url, endpoint, kind, headers) {
        let res;
        try {
            res = await this.#fetch(url, { method: "GET", headers });
        }
        catch {
            return { result: { endpoint, state: "error", status: null, errorKind: "network" }, next: null };
        }
        const status = res.status;
        if (status >= 200 && status < 300) {
            let data;
            try {
                const body = await res.text();
                data = body.length === 0 ? null : JSON.parse(body);
            }
            catch {
                return { result: { endpoint, state: "error", status, errorKind: "invalid_json" }, next: null };
            }
            const result = { endpoint, state: "read", status, data };
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
            if (kind === "settings")
                return { result: { endpoint, state: "not_permitted", status }, next: null };
            if (kind === "file")
                return { result: { endpoint, state: "read", status, absent: true }, next: null };
            return { result: { endpoint, state: "error", status, errorKind: "not_found" }, next: null };
        }
        return { result: { endpoint, state: "error", status, errorKind: "http_status" }, next: null };
    }
}
function stripData(r) {
    const { data: _data, ...rest } = r;
    return rest;
}
/** Parse the `rel="next"` target out of an RFC 8288 Link header. */
export function parseNextLink(header) {
    if (!header)
        return null;
    for (const part of header.split(",")) {
        const m = /^\s*<([^>]*)>\s*(.*)$/.exec(part);
        if (!m)
            continue;
        const params = m[2] ?? "";
        if (/(^|;)\s*rel\s*=\s*"?([^";]*\s)?next(\s[^";]*)?"?\s*(;|$)/i.test(params))
            return m[1] ?? null;
    }
    return null;
}
