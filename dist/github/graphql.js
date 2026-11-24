// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { DEFAULT_API_URL, deniedState } from "./client.js";
export const GRAPHQL_QUERIES = {
    rulesetBypassRoles: `query DarzRulesetBypassRoles($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    rulesets(first: 50, includeParents: true, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        databaseId
        bypassActors(first: 100) {
          pageInfo { hasNextPage }
          nodes { repositoryRoleDatabaseId repositoryRoleName }
        }
      }
    }
  }
}`,
};
for (const [name, doc] of Object.entries(GRAPHQL_QUERIES)) {
    if (!doc.trimStart().startsWith("query ") || /\b(mutation|subscription)\b/.test(doc)) {
        throw new Error(`darz GraphQL document ${name} is not a read-only query`);
    }
}
/** The GraphQL endpoint for a REST API URL: api.github.com/graphql, or GHES's /api/graphql. */
export function graphqlUrl(apiUrl) {
    const base = apiUrl.replace(/\/+$/, "");
    return base.endsWith("/api/v3") ? `${base.slice(0, -"/api/v3".length)}/api/graphql` : `${base}/graphql`;
}
/**
 * GraphQL error types that answer "this token may not read it". Decided by the
 * error's type field, never by its message.
 */
const NOT_PERMITTED_TYPES = new Set(["FORBIDDEN", "NOT_FOUND", "INSUFFICIENT_SCOPES"]);
/** The state a set of GraphQL errors gives a read whose data is unusable. */
export function errorsState(errors) {
    if (errors.length > 0 && errors.every((e) => e.type !== null && NOT_PERMITTED_TYPES.has(e.type))) {
        return { state: "not_permitted" };
    }
    if (errors.some((e) => e.type === "RATE_LIMITED"))
        return { state: "error", errorKind: "rate_limited" };
    return { state: "error", errorKind: "graphql_errors" };
}
export const MAX_GRAPHQL_PAGES = 100;
export class GraphQLReader {
    #fetch;
    #url;
    #path;
    #token;
    #userAgent;
    #log = [];
    constructor(o) {
        this.#fetch = o.fetch;
        this.#url = graphqlUrl(o.apiUrl ?? DEFAULT_API_URL);
        this.#path = new URL(this.#url).pathname;
        this.#token = o.token && o.token.length > 0 ? o.token : undefined;
        this.#userAgent = o.userAgent ?? "darz";
    }
    log() {
        return this.#log.map((e) => ({ ...e }));
    }
    /** The endpoint as the record names it: the path actually posted to, and the query's name. */
    endpoint(name) {
        return `POST ${this.#path}#${name}`;
    }
    /** One compiled query, logged as one read; `partial` when its data came with errors. */
    async query(name, variables) {
        const r = await this.#send(name, variables);
        this.#record({
            endpoint: r.endpoint,
            state: r.state,
            status: r.status,
            ...(r.errorKind ? { errorKind: r.errorKind } : {}),
            ...(r.state === "read" && r.errors !== undefined ? { partial: true } : {}),
        });
        return r;
    }
    /**
     * A compiled query whose results run over pages, read to the last page and
     * logged as one read with a page count. `step` reads each page; the read
     * stops at the first page that is not usable.
     */
    async queryPages(name, variables, cursor, step) {
        const endpoint = this.endpoint(name);
        let after = null;
        let partial = false;
        let status;
        for (let pages = 1; pages <= MAX_GRAPHQL_PAGES; pages++) {
            const r = await this.#send(name, { ...variables, [cursor]: after });
            status = r.status;
            const s = r.state === "read" ? step(r) : { state: r.state, ...(r.errorKind ? { errorKind: r.errorKind } : {}) };
            if (!("next" in s)) {
                return this.#record({ endpoint, state: s.state, status, pages, ...(s.errorKind ? { errorKind: s.errorKind } : {}) });
            }
            if (s.partial)
                partial = true;
            if (s.next === null)
                return this.#record({ endpoint, state: "read", status, pages, ...(partial ? { partial: true } : {}) });
            // A cursor that does not advance would repeat the same page to the limit.
            if (s.next === after)
                return this.#record({ endpoint, state: "error", status, pages, errorKind: "unexpected_shape" });
            after = s.next;
        }
        // As the REST client records it: no single status explains a page limit.
        return this.#record({ endpoint, state: "error", status: null, pages: MAX_GRAPHQL_PAGES, errorKind: "page_limit" });
    }
    #record(entry) {
        this.#log.push({ ...entry });
        return entry;
    }
    async #send(name, variables) {
        if (!Object.hasOwn(GRAPHQL_QUERIES, name))
            throw new Error(`darz: ${String(name)} is not a compiled query`);
        const endpoint = this.endpoint(name);
        const headers = {
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": this.#userAgent,
        };
        if (this.#token !== undefined)
            headers.authorization = `Bearer ${this.#token}`;
        const body = JSON.stringify({ query: GRAPHQL_QUERIES[name], variables });
        let res;
        try {
            res = await this.#fetch(this.#url, { method: "POST", headers, body });
        }
        catch {
            return { endpoint, state: "error", status: null, errorKind: "network" };
        }
        const status = res.status;
        const denied = deniedState(res);
        if (denied)
            return { endpoint, status, ...denied };
        if (status < 200 || status >= 300)
            return { endpoint, state: "error", status, errorKind: "http_status" };
        let parsed;
        try {
            parsed = JSON.parse(await res.text());
        }
        catch {
            return { endpoint, state: "error", status, errorKind: "invalid_json" };
        }
        if (parsed === null || typeof parsed !== "object")
            return { endpoint, state: "error", status, errorKind: "no_data" };
        const errors = (Array.isArray(parsed.errors) ? parsed.errors : []).map((e) => {
            const o = (e !== null && typeof e === "object" ? e : {});
            const path = Array.isArray(o.path) && o.path.every((x) => typeof x === "string" || typeof x === "number")
                ? o.path
                : null;
            return { type: typeof o.type === "string" ? o.type : null, path };
        });
        if (parsed.data === undefined || parsed.data === null) {
            return errors.length > 0
                ? { endpoint, status, ...errorsState(errors) }
                : { endpoint, state: "error", status, errorKind: "no_data" };
        }
        // Data with errors: GraphQL nulls the parts that failed. The caller decides
        // which parts are still usable.
        return errors.length > 0
            ? { endpoint, state: "read", status, data: parsed.data, errors }
            : { endpoint, state: "read", status, data: parsed.data };
    }
}
const NODES_PATH = ["repository", "rulesets", "nodes"];
/**
 * Every ruleset's repository-role bypass actors, with role names, following
 * rulesets to the last page. `roles` is null when any page is not usable: a
 * partial list is not an inventory. A ruleset whose bypass actors run past one
 * page, or that a GraphQL error points into, maps to null; other rulesets on
 * the same page are still used. An error that points at no single ruleset
 * makes the whole read unusable.
 */
export async function readRulesetRoles(reader, owner, name) {
    const out = new Map();
    const result = await reader.queryPages("rulesetBypassRoles", { owner, name }, "after", (page) => {
        const rulesets = page.data.repository?.rulesets;
        const errors = page.errors ?? [];
        const failed = new Set();
        for (const e of errors) {
            const p = e.path;
            const index = p?.[NODES_PATH.length];
            if (!p || !NODES_PATH.every((k, i) => p[i] === k) || typeof index !== "number")
                return errorsState(errors);
            failed.add(index);
        }
        if (!rulesets || !Array.isArray(rulesets.nodes))
            return { state: "error", errorKind: "unexpected_shape" };
        rulesets.nodes.forEach((rs, i) => {
            if (!rs || typeof rs.databaseId !== "number")
                return;
            const actors = rs.bypassActors;
            if (failed.has(i) || !actors || !Array.isArray(actors.nodes) || actors.pageInfo?.hasNextPage !== false) {
                out.set(rs.databaseId, null);
                return;
            }
            const roles = new Map();
            for (const a of actors.nodes) {
                if (a && typeof a.repositoryRoleDatabaseId === "number" && typeof a.repositoryRoleName === "string") {
                    roles.set(a.repositoryRoleDatabaseId, a.repositoryRoleName);
                }
            }
            out.set(rs.databaseId, roles);
        });
        const partial = errors.length > 0;
        if (rulesets.pageInfo?.hasNextPage !== true)
            return { next: null, partial };
        const next = rulesets.pageInfo.endCursor;
        return typeof next === "string" ? { next, partial } : { state: "error", errorKind: "unexpected_shape" };
    });
    return { endpoint: reader.endpoint("rulesetBypassRoles"), roles: result.state === "read" ? out : null };
}
