// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// An opt-in GraphQL reader for the one thing REST cannot say: which repository
// role a ruleset bypass actor is. REST gives only an undocumented actor_id; the
// GraphQL schema has repositoryRoleName. GraphQL queries are POST requests, so
// this is the single, named exception to "GET only": off by default, fixed
// query documents only, never a mutation, the configured host only.

import { describe, expect, it } from "vitest";
import { type Assessment, type AssessOptions, assess } from "../src/assess.js";
import { deniedState } from "../src/github/client.js";
import { GRAPHQL_QUERIES, GraphQLReader, graphqlUrl } from "../src/github/graphql.js";
import { type FakeCall, type FakeResponse, fakeFetch } from "./helpers/fake-fetch.js";
import { FORBIDDEN, type Fixture, REPO, collaborator, goodFixture, ok, ruleset, toRoutes } from "./fixtures/github.js";

const SENTINEL = "ghp_GRAPHQL_SENTINEL_never_print_0123456789";

interface GqlRuleset {
  id: number;
  actors: Array<{ roleId: number | null; roleName: string | null }>;
  more?: boolean;
}

function gqlPage(rulesets: GqlRuleset[], next: string | null = null): FakeResponse {
  return ok({
    data: {
      repository: {
        rulesets: {
          pageInfo: { hasNextPage: next !== null, endCursor: next },
          nodes: rulesets.map((r) => ({
            databaseId: r.id,
            bypassActors: {
              pageInfo: { hasNextPage: r.more ?? false },
              nodes: r.actors.map((a) => ({ repositoryRoleDatabaseId: a.roleId, repositoryRoleName: a.roleName })),
            },
          })),
        },
      },
    },
  });
}

function withGraphql(fx: Fixture, answer: FakeResponse | ((call: FakeCall) => FakeResponse)) {
  const routes = toRoutes(fx);
  routes["/graphql"] = answer;
  return fakeFetch(routes);
}

async function run(f: ReturnType<typeof fakeFetch>, extra: Partial<AssessOptions> = {}): Promise<Assessment> {
  return assess({
    repo: REPO,
    fetch: f.fetch,
    agents: ["coder-agent"],
    graphqlRulesetRoles: true,
    now: () => new Date("2026-11-23T12:00:00Z"),
    ...extra,
  });
}

const row = (a: Assessment) => a.checks.find((c) => c.id === "agents_cannot_bypass");
const codes = (a: Assessment) => row(a)?.reasons.map((r) => r.code) ?? [];

function roleBypass(fx: Fixture, roleId = 4) {
  fx.rulesets = { 42: ruleset(42, [{ actor_id: roleId, actor_type: "RepositoryRole", bypass_mode: "always" }]) };
  return fx;
}

describe("the GraphQL reader is read-only by construction", () => {
  it("every compiled query document is a query, never a mutation or subscription", () => {
    const docs = Object.values(GRAPHQL_QUERIES);
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(doc.trimStart().startsWith("query ")).toBe(true);
      expect(doc).not.toMatch(/\b(mutation|subscription)\b/);
    }
  });

  it("refuses a query name that is not compiled in, without touching the network", async () => {
    const f = fakeFetch({});
    const reader = new GraphQLReader({ fetch: f.fetch });
    await expect(reader.query("deleteRepository" as never, {})).rejects.toThrow(/not a compiled query/);
    expect(f.calls).toHaveLength(0);
  });

  it("posts only the compiled document, to the configured host's /graphql, with the token as a header", async () => {
    const f = fakeFetch({ "/graphql": gqlPage([]) });
    const reader = new GraphQLReader({ fetch: f.fetch, token: SENTINEL });
    const r = await reader.query("rulesetBypassRoles", { owner: "acme", name: "widget", after: null });
    expect(r.state).toBe("read");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(f.calls[0]?.method).toBe("POST");
    expect(JSON.parse(f.calls[0]?.body ?? "{}").query).toBe(GRAPHQL_QUERIES.rulesetBypassRoles);
    expect(f.calls[0]?.headers.authorization).toBe(`Bearer ${SENTINEL}`);
    expect(JSON.stringify(reader.log())).not.toContain(SENTINEL);
    expect(reader.log()[0]?.endpoint).toBe("POST /graphql#rulesetBypassRoles");
  });

  it("finds GitHub Enterprise Server's GraphQL endpoint from its REST URL", () => {
    expect(graphqlUrl("https://api.github.com")).toBe("https://api.github.com/graphql");
    expect(graphqlUrl("https://ghe.example.com/api/v3")).toBe("https://ghe.example.com/api/graphql");
  });

  it("a GraphQL FORBIDDEN error is not_permitted; other errors are error", async () => {
    const forbidden = new GraphQLReader({ fetch: fakeFetch({ "/graphql": ok({ data: null, errors: [{ type: "FORBIDDEN", message: "x" }] }) }).fetch });
    expect((await forbidden.query("rulesetBypassRoles", { owner: "a", name: "b", after: null })).state).toBe("not_permitted");
    const other = new GraphQLReader({ fetch: fakeFetch({ "/graphql": ok({ data: null, errors: [{ type: "SOMETHING", message: "x" }] }) }).fetch });
    expect((await other.query("rulesetBypassRoles", { owner: "a", name: "b", after: null })).state).toBe("error");
  });
});

describe("off by default", () => {
  it("without the flag, Darz sends no POST at all", async () => {
    const f = withGraphql(roleBypass(goodFixture()), gqlPage([{ id: 42, actors: [{ roleId: 4, roleName: "Write" }] }]));
    const a = await run(f, { graphqlRulesetRoles: false });
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(codes(a)).toEqual(["bypass_role_unknown"]);
  });
});

describe("check 4 with role names from GraphQL", () => {
  it("an agent that holds the bypass role fails, agent_role_can_bypass", async () => {
    const f = withGraphql(roleBypass(goodFixture()), gqlPage([{ id: 42, actors: [{ roleId: 4, roleName: "Write" }] }]));
    const a = await run(f);
    expect(row(a)?.status).toBe("fail");
    expect(row(a)?.reasons[0]).toMatchObject({ code: "agent_role_can_bypass", subjects: ["coder-agent holds the Write role, which can bypass ruleset 42"] });
  });

  it("an agent whose role is lower than the bypass role is not covered", async () => {
    const f = withGraphql(roleBypass(goodFixture(), 5), gqlPage([{ id: 42, actors: [{ roleId: 5, roleName: "Admin" }] }]));
    expect(row(await run(f))?.status).toBe("pass");
  });

  it("an agent whose role is higher is unverifiable: whether a role's bypass covers higher roles is not documented", async () => {
    const fx = roleBypass(goodFixture());
    fx.collaborators = [[collaborator("alice", "admin"), collaborator("coder-agent", "maintain")]];
    const f = withGraphql(fx, gqlPage([{ id: 42, actors: [{ roleId: 4, roleName: "Write" }] }]));
    const a = await run(f);
    expect(row(a)?.status).toBe("unverifiable");
    expect(codes(a)).toEqual(["bypass_role_inheritance_unknown"]);
  });

  it("a custom role matches an agent whose collaborator role_name is that role", async () => {
    const fx = roleBypass(goodFixture(), 77);
    fx.collaborators = [[collaborator("alice", "admin"), { ...collaborator("coder-agent", "write"), role_name: "Release manager" }]];
    const f = withGraphql(fx, gqlPage([{ id: 42, actors: [{ roleId: 77, roleName: "Release manager" }] }]));
    expect(codes(await run(f))).toEqual(["agent_role_can_bypass"]);
  });

  it("a custom role against a built-in agent role stays unverifiable, with its own reason", async () => {
    const f = withGraphql(roleBypass(goodFixture(), 77), gqlPage([{ id: 42, actors: [{ roleId: 77, roleName: "Release manager" }] }]));
    expect(codes(await run(f))).toEqual(["bypass_role_order_unknown"]);
  });

  it("a GraphQL FORBIDDEN falls back to bypass_role_unknown, and the read is recorded", async () => {
    const f = withGraphql(roleBypass(goodFixture()), ok({ data: null, errors: [{ type: "FORBIDDEN", message: "x" }] }));
    const a = await run(f);
    expect(codes(a)).toEqual(["bypass_role_unknown"]);
    expect(a.reads).toContainEqual(expect.objectContaining({ endpoint: "POST /graphql#rulesetBypassRoles", state: "not_permitted" }));
  });

  it("a ruleset whose bypass actors run past one page is not used", async () => {
    const f = withGraphql(roleBypass(goodFixture()), gqlPage([{ id: 42, actors: [{ roleId: 4, roleName: "Write" }], more: true }]));
    expect(codes(await run(f))).toEqual(["bypass_role_unknown"]);
  });

  it("reads every page of rulesets", async () => {
    const pages = (call: FakeCall) => {
      const after = JSON.parse(call.body ?? "{}").variables?.after ?? null;
      return after === null
        ? gqlPage([{ id: 7, actors: [] }], "c1")
        : gqlPage([{ id: 42, actors: [{ roleId: 4, roleName: "Write" }] }]);
    };
    const f = withGraphql(roleBypass(goodFixture()), pages);
    const a = await run(f);
    expect(codes(a)).toEqual(["agent_role_can_bypass"]);
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("the token never appears in any output", async () => {
    const f = withGraphql(roleBypass(goodFixture()), ok({ data: null, errors: [{ type: "FORBIDDEN", message: SENTINEL }] }));
    const a = await run(f, { token: SENTINEL });
    expect(JSON.stringify(a)).not.toContain(SENTINEL);
  });

  it("a FORBIDDEN on the REST ruleset is still ruleset_unreadable", async () => {
    const fx = goodFixture();
    fx.rulesets = { 42: FORBIDDEN };
    const f = withGraphql(fx, gqlPage([]));
    expect(codes(await run(f))).toEqual(["ruleset_unreadable"]);
  });
});

// Review findings on the GraphQL reader: each block below names the finding it covers.

function gqlNodes(nodes: unknown[], errors?: unknown[]): FakeResponse {
  const body: Record<string, unknown> = {
    data: { repository: { rulesets: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } },
  };
  if (errors !== undefined) body.errors = errors;
  return ok(body);
}

const rulesetNode = (id: number, actors: Array<[number, string]>) => ({
  databaseId: id,
  bypassActors: {
    pageInfo: { hasNextPage: false },
    nodes: actors.map(([roleId, roleName]) => ({ repositoryRoleDatabaseId: roleId, repositoryRoleName: roleName })),
  },
});

describe("role names are used only when GraphQL's role ids match REST's actor_ids", () => {
  it("a ruleset whose GraphQL role ids are not exactly its REST actor_ids stays unverifiable", async () => {
    // REST names role 5 only; GraphQL names roles 5 and 9. The two lists disagree,
    // so which name belongs to REST's actor is not known, and the row cannot pass.
    const f = withGraphql(
      roleBypass(goodFixture(), 5),
      gqlPage([{ id: 42, actors: [{ roleId: 5, roleName: "Admin" }, { roleId: 9, roleName: "Write" }] }]),
    );
    const a = await run(f);
    expect(row(a)?.status).toBe("unverifiable");
    expect(codes(a)).toEqual(["bypass_role_unknown"]);
    expect(row(a)?.context.join("\n")).toMatch(/role ids .*differ/i);
  });
});

describe("a GraphQL error costs only the ruleset it is about", () => {
  it("an error inside one ruleset's bypass actors leaves the other rulesets decided", async () => {
    const f = withGraphql(
      roleBypass(goodFixture()),
      gqlNodes(
        [rulesetNode(42, [[4, "Write"]]), { databaseId: 99, bypassActors: null }],
        [{ type: "FORBIDDEN", message: "x", path: ["repository", "rulesets", "nodes", 1, "bypassActors"] }],
      ),
    );
    const a = await run(f);
    expect(codes(a)).toEqual(["agent_role_can_bypass"]);
    expect(a.reads).toContainEqual(expect.objectContaining({ endpoint: "POST /graphql#rulesetBypassRoles", state: "read", partial: true }));
  });

  it("an error inside the ruleset being checked leaves that ruleset unverifiable", async () => {
    const f = withGraphql(
      roleBypass(goodFixture()),
      gqlNodes(
        [{ databaseId: 42, bypassActors: null }],
        [{ type: "FORBIDDEN", message: "x", path: ["repository", "rulesets", "nodes", 0, "bypassActors"] }],
      ),
    );
    expect(codes(await run(f))).toEqual(["bypass_role_unknown"]);
  });

  it("an error that names no ruleset makes the whole read unusable", async () => {
    const f = withGraphql(roleBypass(goodFixture()), gqlNodes([rulesetNode(42, [[4, "Write"]])], [{ type: "SOMETHING", message: "x" }]));
    const a = await run(f);
    expect(codes(a)).toEqual(["bypass_role_unknown"]);
    expect(a.reads).toContainEqual(expect.objectContaining({ endpoint: "POST /graphql#rulesetBypassRoles", state: "error" }));
  });
});

describe("check 4 says when it used the GraphQL read", () => {
  it("the row's read list includes the GraphQL read", async () => {
    const f = withGraphql(roleBypass(goodFixture()), gqlPage([{ id: 42, actors: [{ roleId: 4, roleName: "Write" }] }]));
    expect(row(await run(f))?.read).toContain("POST /graphql#rulesetBypassRoles");
  });

  it("a failed GraphQL read is named in the row's context, not silent", async () => {
    const f = withGraphql(roleBypass(goodFixture()), ok({ data: null, errors: [{ type: "FORBIDDEN", message: "x" }] }));
    const a = await run(f);
    expect(codes(a)).toEqual(["bypass_role_unknown"]);
    expect(row(a)?.context.join("\n")).toMatch(/--graphql-ruleset-roles/);
  });
});

describe("GraphQL error types", () => {
  const answer = async (body: unknown) => {
    const reader = new GraphQLReader({ fetch: fakeFetch({ "/graphql": ok(body) }).fetch });
    return reader.query("rulesetBypassRoles", { owner: "a", name: "b", after: null });
  };

  it("INSUFFICIENT_SCOPES is not_permitted, like FORBIDDEN and NOT_FOUND", async () => {
    expect((await answer({ data: null, errors: [{ type: "INSUFFICIENT_SCOPES", message: "x" }] })).state).toBe("not_permitted");
  });

  it("RATE_LIMITED is an error of kind rate_limited", async () => {
    expect(await answer({ data: null, errors: [{ type: "RATE_LIMITED", message: "x" }] })).toMatchObject({
      state: "error",
      errorKind: "rate_limited",
    });
  });

  it("a throttled 403 is a rate limit, decided as the REST client decides it", async () => {
    const reader = new GraphQLReader({
      fetch: fakeFetch({ "/graphql": { status: 403, body: {}, headers: { "x-ratelimit-remaining": "0" } } }).fetch,
    });
    const r = await reader.query("rulesetBypassRoles", { owner: "a", name: "b", after: null });
    expect(r).toMatchObject({ state: "error", errorKind: "rate_limited" });
    expect(deniedState({ status: 403, headers: { get: (h: string) => (h === "retry-after" ? "1" : null) }, text: async () => "" })).toEqual({
      state: "error",
      errorKind: "rate_limited",
    });
    expect(deniedState({ status: 403, headers: { get: () => null }, text: async () => "" })).toEqual({ state: "not_permitted" });
    expect(deniedState({ status: 500, headers: { get: () => null }, text: async () => "" })).toBeNull();
  });
});

describe("the GraphQL read happens only when it can matter", () => {
  it("with the flag on and no repository-role bypass actor, Darz sends no POST", async () => {
    const f = withGraphql(goodFixture(), gqlPage([]));
    const a = await run(f);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(row(a)?.status).toBe("pass");
  });
});

describe("how GraphQL reads are logged", () => {
  it("names GitHub Enterprise Server's /api/graphql path", async () => {
    const f = fakeFetch({ "https://ghe.example.com/api/graphql": gqlPage([]) }, "https://ghe.example.com/api/v3");
    const reader = new GraphQLReader({ fetch: f.fetch, apiUrl: "https://ghe.example.com/api/v3" });
    await reader.query("rulesetBypassRoles", { owner: "a", name: "b", after: null });
    expect(reader.log()[0]?.endpoint).toBe("POST /api/graphql#rulesetBypassRoles");
  });

  it("a paged read is one entry with a page count", async () => {
    const pages = (call: FakeCall) =>
      (JSON.parse(call.body ?? "{}").variables?.after ?? null) === null
        ? gqlPage([{ id: 7, actors: [] }], "c1")
        : gqlPage([{ id: 42, actors: [{ roleId: 4, roleName: "Write" }] }]);
    const a = await run(withGraphql(roleBypass(goodFixture()), pages));
    const entries = a.reads.filter((r) => r.endpoint.startsWith("POST "));
    expect(entries).toEqual([{ endpoint: "POST /graphql#rulesetBypassRoles", state: "read", status: 200, pages: 2 }]);
  });
});

// Follow-ups from a second review of the GraphQL reader.

describe("the GraphQL read is sent only when check 4 can use it", () => {
  it("no POST when no agent identity holds a repository permission", async () => {
    const fx = roleBypass(goodFixture());
    fx.collaborators = [[collaborator("alice", "admin")]];
    const f = withGraphql(fx, gqlPage([{ id: 42, actors: [{ roleId: 4, roleName: "Write" }] }]));
    const a = await run(f);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
    expect(row(a)?.status).toBe("pass");
    expect(row(a)?.context.join("\n")).not.toMatch(/--graphql-ruleset-roles/);
  });

  it("no POST when the collaborators list was not read", async () => {
    const fx = roleBypass(goodFixture());
    fx.collaborators = FORBIDDEN;
    const f = withGraphql(fx, gqlPage([{ id: 42, actors: [{ roleId: 4, roleName: "Write" }] }]));
    await run(f);
    expect(f.calls.every((c) => c.method === "GET")).toBe(true);
  });
});

describe("paging guards", () => {
  it("a cursor that does not advance stops the read as unexpected_shape", async () => {
    const f = withGraphql(roleBypass(goodFixture()), gqlPage([{ id: 7, actors: [] }], "same"));
    const a = await run(f);
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    expect(a.reads).toContainEqual(
      expect.objectContaining({ endpoint: "POST /graphql#rulesetBypassRoles", state: "error", errorKind: "unexpected_shape" }),
    );
    expect(codes(a)).toEqual(["bypass_role_unknown"]);
  });

  it("a single query with data and errors is logged as partial", async () => {
    const reader = new GraphQLReader({
      fetch: fakeFetch({
        "/graphql": gqlNodes([], [{ type: "FORBIDDEN", message: "x", path: ["repository", "rulesets", "nodes", 0, "bypassActors"] }]),
      }).fetch,
    });
    await reader.query("rulesetBypassRoles", { owner: "a", name: "b", after: null });
    expect(reader.log()[0]).toMatchObject({ state: "read", partial: true });
  });
});
