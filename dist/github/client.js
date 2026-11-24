// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
export const DEFAULT_API_URL = "https://api.github.com";
/**
 * Redirects followed per request. GitHub answers a read of a renamed or
 * transferred repository with one 301 to `/repositories/{id}/...`.
 */
export const MAX_REDIRECTS = 3;
/** Statuses whose `Location` is followed, as a GET. 300 and 304 are not redirects to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
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
export function deniedState(res) {
    const status = res.status;
    const throttled = res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null;
    if (status === 429 || ((status === 403 || status === 401) && throttled))
        return { state: "error", errorKind: "rate_limited" };
    if (status === 401 || status === 403)
        return { state: "not_permitted" };
    return null;
}
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
        const { result, hops } = await this.#getUrl(this.#urlFor(path), path, kind);
        return this.#record(result, hops);
    }
    async get(path, kind = "content") {
        return (await this.request("GET", path, kind));
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
    async getAll(path, kind = "content", enough, pageCap, itemsKey) {
        const items = [];
        let url = this.#urlFor(path);
        let pages = 0;
        const pageEndpoints = [];
        // The first page's hops start with the requested path; a later page's
        // hops (rare) add only the URLs it was redirected to.
        const hops = [];
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
                return this.#record({ ...stripData(result), endpoint: path, pages }, hops);
            }
            if (result.absent) {
                return this.#record({ endpoint: path, state: "read", status: result.status, absent: true, pages }, hops);
            }
            const list = itemsKey === undefined
                ? result.data
                : typeof result.data === "object" && result.data !== null
                    ? result.data[itemsKey]
                    : undefined;
            if (!Array.isArray(list)) {
                return this.#record({ endpoint: path, state: "error", status: result.status, pages, errorKind: "not_a_list" }, hops);
            }
            items.push(...list);
            if (enough?.(items))
                break;
            if (next !== null && !this.#isOwnUrl(next)) {
                return this.#record({ endpoint: path, state: "error", status: result.status, pages, errorKind: "foreign_link" }, hops);
            }
            if (next !== null && pageCap !== undefined && pages >= pageCap) {
                const capped = { endpoint: path, state: "read", status: 200, data: items, pages, capped: true, pageEndpoints };
                this.#record(capped, hops);
                return capped;
            }
            url = next;
        }
        const final = { endpoint: path, state: "read", status: 200, data: items, pages, pageEndpoints };
        this.#record(final, hops);
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
    /**
     * Log one read. A read that followed redirects gets one more entry per URL
     * a redirect sent it to (`hops` after the first). Each entry carries the
     * status that URL answered, and all carry how the read ended. The requested
     * path's entry keeps the page count, so a check's `read` list still points
     * at an entry that says whether the read succeeded.
     */
    #record(result, hops = []) {
        const redirected = hops.length > 1;
        const entry = {
            endpoint: result.endpoint,
            state: result.state,
            status: redirected ? (hops[0]?.status ?? null) : result.status,
        };
        if (result.pages !== undefined)
            entry.pages = result.pages;
        if (result.absent)
            entry.absent = true;
        if (result.errorKind !== undefined)
            entry.errorKind = result.errorKind;
        this.#log.push(entry);
        if (redirected) {
            for (const hop of hops.slice(1)) {
                const e = { endpoint: hop.endpoint, state: result.state, status: hop.status };
                if (result.absent)
                    e.absent = true;
                if (result.errorKind !== undefined)
                    e.errorKind = result.errorKind;
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
    #ownRedirect(location, from) {
        let target;
        let api;
        try {
            target = new URL(location, from);
            api = new URL(this.apiUrl);
        }
        catch {
            return null;
        }
        if (target.origin !== api.origin || target.username !== "" || target.password !== "")
            return null;
        const base = api.pathname.replace(/\/+$/, "");
        if (target.pathname !== base && !target.pathname.startsWith(`${base}/`))
            return null;
        const rest = target.pathname.slice(base.length) || "/";
        return `${this.apiUrl}${rest}${target.search}`;
    }
    /** The path under the API URL that an own URL names. */
    #pathOf(url) {
        return url.slice(this.apiUrl.length) || "/";
    }
    async #getUrl(url, endpoint, kind) {
        if (!this.#isOwnUrl(url)) {
            return { result: { endpoint, state: "error", status: null, errorKind: "foreign_host" }, next: null, hops: [] };
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
            // Follow redirects to the API URL only. The token goes only to URLs
            // that pass the same own-URL test as the first request.
            const hops = [];
            let current = url;
            for (;;) {
                const got = await this.#fetchOne(current, endpoint, kind, headers);
                hops.push({ endpoint: this.#pathOf(current), status: got.result.status });
                if (got.location === undefined)
                    return { result: got.result, next: got.next, hops };
                const status = got.result.status;
                const fail = (errorKind) => ({ result: { endpoint, state: "error", status, errorKind }, next: null, hops });
                if (got.location === null)
                    return fail("redirect_without_location");
                const target = this.#ownRedirect(got.location, current);
                if (target === null)
                    return fail("foreign_redirect");
                if (hops.length > MAX_REDIRECTS)
                    return fail("redirect_limit");
                current = target;
            }
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
        if (REDIRECT_STATUSES.has(status)) {
            // Classified by the caller, which decides whether to follow it.
            return { result: { endpoint, state: "error", status, errorKind: "http_status" }, next: null, location: res.headers.get("location") };
        }
        const denied = deniedState(res);
        if (denied)
            return { result: { endpoint, status, ...denied }, next: null };
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
