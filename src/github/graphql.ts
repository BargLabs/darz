// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

/**
 * The one exception to "GET requests only": an opt-in GraphQL reader.
 *
 * REST names a ruleset's repository-role bypass actor only by an undocumented
 * numeric actor_id. GitHub's GraphQL schema gives the role's name
 * (RepositoryRulesetBypassActor.repositoryRoleName). GraphQL queries travel as
 * POST requests, so this reader is kept apart from the GET-only client:
 * - it is used only when the caller asks for it (--graphql-ruleset-roles);
 * - it sends only query documents compiled into Darz, chosen by name, and
 *   checks at load that none is a mutation or subscription;
 * - it calls only the configured API host's GraphQL endpoint;
 * - the token is a header only, as in the GET client.
 */

import type { FetchLike, ReadLogEntry, ReadResult } from "./client.js";
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
} as const;

export type QueryName = keyof typeof GRAPHQL_QUERIES;

for (const [name, doc] of Object.entries(GRAPHQL_QUERIES)) {
  if (!doc.trimStart().startsWith("query ") || /\b(mutation|subscription)\b/.test(doc)) {
    throw new Error(`darz GraphQL document ${name} is not a read-only query`);
  }
}

/** The GraphQL endpoint for a REST API URL: api.github.com/graphql, or GHES's /api/graphql. */
export function graphqlUrl(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, "");
  return base.endsWith("/api/v3") ? `${base.slice(0, -"/api/v3".length)}/api/graphql` : `${base}/graphql`;
}

/**
 * GraphQL error types that answer "this token may not read it". Decided by the
 * error's type field, never by its message.
 */
const NOT_PERMITTED_TYPES = new Set(["FORBIDDEN", "NOT_FOUND", "INSUFFICIENT_SCOPES"]);

/** An entry of a GraphQL response's `errors`: its type and where in the data it happened. */
export interface GraphQLError {
  type: string | null;
  path: Array<string | number> | null;
}

/** A GraphQL read. When `state` is `read`, `errors` lists errors on parts of the data, if any. */
export interface GraphQLResult extends ReadResult {
  errors?: GraphQLError[];
}

/** The state a set of GraphQL errors gives a read whose data is unusable. */
export function errorsState(errors: GraphQLError[]): Pick<ReadResult, "state" | "errorKind"> {
  if (errors.length > 0 && errors.every((e) => e.type !== null && NOT_PERMITTED_TYPES.has(e.type))) {
    return { state: "not_permitted" };
  }
  if (errors.some((e) => e.type === "RATE_LIMITED")) return { state: "error", errorKind: "rate_limited" };
  return { state: "error", errorKind: "graphql_errors" };
}

export interface GraphQLReaderOptions {
  fetch: FetchLike;
  apiUrl?: string;
  token?: string;
  userAgent?: string;
}

/**
 * What a paged query's caller makes of one page: the cursor of the next page
 * (null after the last), or the state the whole read takes if the page is not
 * usable. `partial` marks a page whose data had errors on some parts.
 */
export type PageStep = { next: string | null; partial?: boolean } | Pick<ReadResult, "state" | "errorKind">;

export const MAX_GRAPHQL_PAGES = 100;

export class GraphQLReader {
  readonly #fetch: FetchLike;
  readonly #url: string;
  readonly #path: string;
  readonly #token: string | undefined;
  readonly #userAgent: string;
  readonly #log: ReadLogEntry[] = [];

  constructor(o: GraphQLReaderOptions) {
    this.#fetch = o.fetch;
    this.#url = graphqlUrl(o.apiUrl ?? DEFAULT_API_URL);
    this.#path = new URL(this.#url).pathname;
    this.#token = o.token && o.token.length > 0 ? o.token : undefined;
    this.#userAgent = o.userAgent ?? "darz";
  }

  log(): ReadLogEntry[] {
    return this.#log.map((e) => ({ ...e }));
  }

  /** The endpoint as the record names it: the path actually posted to, and the query's name. */
  endpoint(name: QueryName): string {
    return `POST ${this.#path}#${name}`;
  }

  /** One compiled query, logged as one read; `partial` when its data came with errors. */
  async query(name: QueryName, variables: Record<string, string | null>): Promise<GraphQLResult> {
    const r = await this.#send(name, variables);
    this.#record({
      endpoint: r.endpoint,
      state: r.state,
      status: r.status,
      ...(r.errorKind ? { errorKind: r.errorKind } : {}),
      ...(r.state === "read" && r.errors !== undefined ? { partial: true as const } : {}),
    });
    return r;
  }

  /**
   * A compiled query whose results run over pages, read to the last page and
   * logged as one read with a page count. `step` reads each page; the read
   * stops at the first page that is not usable.
   */
  async queryPages(
    name: QueryName,
    variables: Record<string, string | null>,
    cursor: string,
    step: (page: GraphQLResult) => PageStep,
  ): Promise<ReadResult> {
    const endpoint = this.endpoint(name);
    let after: string | null = null;
    let partial = false;
    let status: number | null;
    for (let pages = 1; pages <= MAX_GRAPHQL_PAGES; pages++) {
      const r = await this.#send(name, { ...variables, [cursor]: after });
      status = r.status;
      const s: PageStep = r.state === "read" ? step(r) : { state: r.state, ...(r.errorKind ? { errorKind: r.errorKind } : {}) };
      if (!("next" in s)) {
        return this.#record({ endpoint, state: s.state, status, pages, ...(s.errorKind ? { errorKind: s.errorKind } : {}) });
      }
      if (s.partial) partial = true;
      if (s.next === null) return this.#record({ endpoint, state: "read", status, pages, ...(partial ? { partial: true } : {}) });
      // A cursor that does not advance would repeat the same page to the limit.
      if (s.next === after) return this.#record({ endpoint, state: "error", status, pages, errorKind: "unexpected_shape" });
      after = s.next;
    }
    // As the REST client records it: no single status explains a page limit.
    return this.#record({ endpoint, state: "error", status: null, pages: MAX_GRAPHQL_PAGES, errorKind: "page_limit" });
  }

  #record<T extends ReadLogEntry>(entry: T): T {
    this.#log.push({ ...entry });
    return entry;
  }

  async #send(name: QueryName, variables: Record<string, string | null>): Promise<GraphQLResult> {
    if (!Object.hasOwn(GRAPHQL_QUERIES, name)) throw new Error(`darz: ${String(name)} is not a compiled query`);
    const endpoint = this.endpoint(name);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": this.#userAgent,
    };
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
    const body = JSON.stringify({ query: GRAPHQL_QUERIES[name], variables });
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.#fetch(this.#url, { method: "POST", headers, body });
    } catch {
      return { endpoint, state: "error", status: null, errorKind: "network" };
    }
    const status = res.status;
    const denied = deniedState(res);
    if (denied) return { endpoint, status, ...denied };
    if (status < 200 || status >= 300) return { endpoint, state: "error", status, errorKind: "http_status" };
    let parsed: { data?: unknown; errors?: unknown };
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      return { endpoint, state: "error", status, errorKind: "invalid_json" };
    }
    if (parsed === null || typeof parsed !== "object") return { endpoint, state: "error", status, errorKind: "no_data" };
    const errors: GraphQLError[] = (Array.isArray(parsed.errors) ? parsed.errors : []).map((e: unknown) => {
      const o = (e !== null && typeof e === "object" ? e : {}) as { type?: unknown; path?: unknown };
      const path =
        Array.isArray(o.path) && o.path.every((x) => typeof x === "string" || typeof x === "number")
          ? (o.path as Array<string | number>)
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

/** Role names per ruleset: ruleset id -> (role id -> role name), or null where a ruleset's list was not fully read. */
export type RulesetRoles = Map<number, Map<number, string> | null>;

/** The GraphQL read of ruleset role names, as check 4 uses it. */
export interface RulesetRolesRead {
  /** The read as the record names it, for the check row's read list. */
  endpoint: string;
  /** Null when the read failed or was incomplete. */
  roles: RulesetRoles | null;
}

interface RulesetsPage {
  repository?: {
    rulesets?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: Array<{
        databaseId?: number;
        bypassActors?: {
          pageInfo?: { hasNextPage?: boolean };
          nodes?: Array<{ repositoryRoleDatabaseId?: number | null; repositoryRoleName?: string | null } | null>;
        } | null;
      } | null>;
    } | null;
  } | null;
}

const NODES_PATH = ["repository", "rulesets", "nodes"] as const;

/**
 * Every ruleset's repository-role bypass actors, with role names, following
 * rulesets to the last page. `roles` is null when any page is not usable: a
 * partial list is not an inventory. A ruleset whose bypass actors run past one
 * page, or that a GraphQL error points into, maps to null; other rulesets on
 * the same page are still used. An error that points at no single ruleset
 * makes the whole read unusable.
 */
export async function readRulesetRoles(reader: GraphQLReader, owner: string, name: string): Promise<RulesetRolesRead> {
  const out: RulesetRoles = new Map();
  const result = await reader.queryPages("rulesetBypassRoles", { owner, name }, "after", (page) => {
    const rulesets = (page.data as RulesetsPage).repository?.rulesets;
    const errors = page.errors ?? [];
    const failed = new Set<number>();
    for (const e of errors) {
      const p = e.path;
      const index = p?.[NODES_PATH.length];
      if (!p || !NODES_PATH.every((k, i) => p[i] === k) || typeof index !== "number") return errorsState(errors);
      failed.add(index);
    }
    if (!rulesets || !Array.isArray(rulesets.nodes)) return { state: "error", errorKind: "unexpected_shape" };
    rulesets.nodes.forEach((rs, i) => {
      if (!rs || typeof rs.databaseId !== "number") return;
      const actors = rs.bypassActors;
      if (failed.has(i) || !actors || !Array.isArray(actors.nodes) || actors.pageInfo?.hasNextPage !== false) {
        out.set(rs.databaseId, null);
        return;
      }
      const roles = new Map<number, string>();
      for (const a of actors.nodes) {
        if (a && typeof a.repositoryRoleDatabaseId === "number" && typeof a.repositoryRoleName === "string") {
          roles.set(a.repositoryRoleDatabaseId, a.repositoryRoleName);
        }
      }
      out.set(rs.databaseId, roles);
    });
    const partial = errors.length > 0;
    if (rulesets.pageInfo?.hasNextPage !== true) return { next: null, partial };
    const next = rulesets.pageInfo.endCursor;
    return typeof next === "string" ? { next, partial } : { state: "error", errorKind: "unexpected_shape" };
  });
  return { endpoint: reader.endpoint("rulesetBypassRoles"), roles: result.state === "read" ? out : null };
}
