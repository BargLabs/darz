// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { ownerKind, parseCodeowners } from "./codeowners.js";
import { type Snapshot, codeownersErrorsInUse, errorLines, parseAppFlag } from "./github/snapshot.js";

export type IdentitySource = "declared" | "detected";
export type FoundIn = "flag" | "config" | "collaborators" | "ruleset_bypass" | "codeowners" | "merge_authors";

export interface AgentIdentity {
  kind: "user" | "app";
  /** Users only. */
  login?: string;
  /** Apps only: the app slug (its bot account is `<slug>[bot]`). */
  slug?: string;
  /** Apps only, when known: from a ruleset bypass actor or `GET /apps/{slug}`. */
  appId?: number;
  source: IdentitySource;
  foundIn: FoundIn[];
}

/**
 * GitHub Actions' own app. Every workflow's token acts as it, and most
 * repositories pin their required checks to it, so it is a platform identity,
 * not an agent: it is not detected from merge authors, collaborators or
 * CODEOWNERS. A ruleset bypass for it is still detected, since then any
 * workflow can go around the rules, and it can still be declared.
 */
export const GITHUB_ACTIONS_SLUG = "github-actions";
export const GITHUB_ACTIONS_APP_ID = 15368;

export function isGitHubActionsLogin(login: string): boolean {
  return login.replace(/\[bot\]$/i, "").toLowerCase() === GITHUB_ACTIONS_SLUG;
}

export function isBotLogin(login: string): boolean {
  return /\[bot\]$/i.test(login);
}

function botSlug(login: string): string {
  return login.replace(/\[bot\]$/i, "");
}

export function identityName(id: AgentIdentity): string {
  if (id.kind === "user") return id.login ?? "";
  if (id.slug) return `${id.slug}[bot]`;
  return `app id ${id.appId}`;
}

export function appLabel(id: AgentIdentity): string {
  if (id.slug && id.appId !== undefined) return `app ${id.slug} (id ${id.appId})`;
  if (id.slug) return `app ${id.slug}`;
  return `app id ${id.appId}`;
}

export class IdentitySet {
  readonly #items: AgentIdentity[] = [];
  /** Declared ids per app slug (lower case) when one slug was declared with different ids. */
  readonly #conflicts = new Map<string, { slug: string; ids: Set<number> }>();
  /** App slugs (lower case) named by a declaration, in a flag or `.github/darz.json`. */
  readonly #declaredSlugs = new Set<string>();
  /** Declared slugs per app id when two different declared slugs turned out to share it. */
  readonly #shared = new Map<number, Map<string, string>>();

  add(kind: "user" | "app", name: string | null, appId: number | null, source: IdentitySource, foundIn: FoundIn) {
    if (kind === "app" && name !== null && source === "declared") this.#declaredSlugs.add(name.toLowerCase());
    const existing = this.#items.find((i) => {
      if (i.kind !== kind) return false;
      if (kind === "user") return (i.login ?? "").toLowerCase() === (name ?? "").toLowerCase();
      if (name !== null && i.slug !== undefined) return i.slug.toLowerCase() === name.toLowerCase();
      if (appId !== null && i.appId !== undefined) return i.appId === appId;
      return false;
    });
    if (existing) {
      if (kind === "app" && name !== null && appId !== null && existing.appId !== undefined && existing.appId !== appId) {
        const key = (existing.slug ?? name).toLowerCase();
        const c = this.#conflicts.get(key) ?? { slug: existing.slug ?? name, ids: new Set([existing.appId]) };
        c.ids.add(appId);
        this.#conflicts.set(key, c);
      }
      if (source === "declared") existing.source = "declared";
      if (!existing.foundIn.includes(foundIn)) existing.foundIn.push(foundIn);
      if (appId !== null && existing.appId === undefined) existing.appId = appId;
      return;
    }
    const id: AgentIdentity = { kind, source, foundIn: [foundIn] };
    if (kind === "user" && name !== null) id.login = name;
    if (kind === "app" && name !== null) id.slug = name;
    if (kind === "app" && appId !== null) id.appId = appId;
    this.#items.push(id);
  }

  addLogin(login: string, source: IdentitySource, foundIn: FoundIn) {
    if (isBotLogin(login)) this.add("app", botSlug(login), null, source, foundIn);
    else this.add("user", login, null, source, foundIn);
  }

  /**
   * Merge app entries that turned out to share an app id. The merged entry
   * keeps the first slug. Two different declared slugs merged this way are
   * recorded: one of them names no app, or a different one.
   */
  mergeByAppId() {
    for (let i = 0; i < this.#items.length; i++) {
      const a = this.#items[i] as AgentIdentity;
      if (a.kind !== "app" || a.appId === undefined) continue;
      for (let j = this.#items.length - 1; j > i; j--) {
        const b = this.#items[j] as AgentIdentity;
        if (b.kind !== "app" || b.appId !== a.appId) continue;
        if (a.slug !== undefined && b.slug !== undefined && a.slug.toLowerCase() !== b.slug.toLowerCase()) {
          const declared = (x: string) => this.#declaredSlugs.has(x.toLowerCase());
          if (declared(a.slug) && declared(b.slug)) {
            const slugs = this.#shared.get(a.appId) ?? new Map<string, string>();
            slugs.set(a.slug.toLowerCase(), a.slug);
            slugs.set(b.slug.toLowerCase(), b.slug);
            this.#shared.set(a.appId, slugs);
          }
        }
        if (b.source === "declared") a.source = "declared";
        if (!a.slug && b.slug) a.slug = b.slug;
        for (const f of b.foundIn) if (!a.foundIn.includes(f)) a.foundIn.push(f);
        this.#items.splice(j, 1);
      }
    }
  }

  list(): AgentIdentity[] {
    return this.#items;
  }

  /**
   * App slugs declared with more than one id. The identity keeps the first id,
   * so which app is the agent is unknown; the checks report it.
   */
  appIdConflicts(): AppIdConflict[] {
    return [...this.#conflicts.values()]
      .map((c) => ({ slug: c.slug, ids: [...c.ids].sort((a, b) => a - b) }))
      .sort((a, b) => (a.slug.toLowerCase() < b.slug.toLowerCase() ? -1 : 1));
  }

  /**
   * App ids that two or more different declared slugs resolve to, after
   * {@link mergeByAppId}. The identity keeps one slug, so a bot login under
   * another may match no identity; the checks report it.
   */
  appSlugsSharingId(): AppSlugShare[] {
    return [...this.#shared.entries()]
      .map(([id, slugs]) => ({ id, slugs: [...slugs.values()].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)) }))
      .sort((a, b) => a.id - b.id);
  }
}

export interface AppIdConflict {
  slug: string;
  ids: number[];
}

export interface AppSlugShare {
  id: number;
  slugs: string[];
}

export interface DeclaredInput {
  agents: readonly string[];
  agentApps: readonly string[];
}

/**
 * Declared identities come from flags and `.github/darz.json`. Detected ones
 * are any account of type `Bot`, or whose login ends in `[bot]`, found in the
 * collaborators list, a ruleset's `Integration` bypass actors, CODEOWNERS
 * entries, or the authors of the merged pull requests read for check 6.
 * github-actions[bot] is not detected from collaborators, CODEOWNERS or merge
 * authors: see GITHUB_ACTIONS_APP_ID.
 */
export function collectIdentities(snap: Snapshot, flags: DeclaredInput): IdentitySet {
  const set = new IdentitySet();
  for (const a of flags.agents) set.addLogin(a, "declared", "flag");
  for (const s of flags.agentApps) {
    const decl = parseAppFlag(s);
    if (!decl) throw new Error(`--agent-app must be a slug or slug=id, not "${s}"`);
    set.add("app", botSlug(decl.slug), decl.id ?? null, "declared", "flag");
  }
  if (snap.config.state === "valid") {
    for (const a of snap.config.config.agents) set.addLogin(a, "declared", "config");
    for (const a of snap.config.config.agentApps) set.add("app", botSlug(a.slug), a.id ?? null, "declared", "config");
  }

  if (snap.collaborators?.state === "read") {
    for (const c of snap.collaborators.data ?? []) {
      if (typeof c.login !== "string" || isGitHubActionsLogin(c.login)) continue;
      if (c.type === "Bot" || isBotLogin(c.login)) set.add("app", botSlug(c.login), null, "detected", "collaborators");
    }
  }

  for (const rs of snap.rulesets.values()) {
    if (rs.state !== "read") continue;
    for (const actor of rs.data?.bypass_actors ?? []) {
      if (actor.actor_type === "Integration" && typeof actor.actor_id === "number") {
        // A bypass actor is known by id only. GitHub Actions' slug is fixed, and
        // without it github-actions[bot]'s merges would match no identity.
        const slug = actor.actor_id === GITHUB_ACTIONS_APP_ID ? GITHUB_ACTIONS_SLUG : null;
        set.add("app", slug, actor.actor_id, "detected", "ruleset_bypass");
      }
    }
  }

  if (snap.codeowners.state === "found") {
    // Lines GitHub reports as errors are skipped, as they are for ownership. If the
    // error list could not be read, every line counts: detecting too many agents is
    // the safe side.
    const errors = codeownersErrorsInUse(snap);
    for (const rule of parseCodeowners(snap.codeowners.text, errors ? errorLines(errors) : []).rules) {
      if (rule.errored) continue;
      for (const owner of rule.owners) {
        if (ownerKind(owner) !== "user") continue;
        const login = owner.slice(1);
        if (isBotLogin(login) && !isGitHubActionsLogin(login)) set.add("app", botSlug(login), null, "detected", "codeowners");
      }
    }
  }

  for (const p of snap.merges.merged) {
    const login = p.user?.login;
    if (typeof login !== "string" || isGitHubActionsLogin(login)) continue;
    if (p.user?.type === "Bot" || isBotLogin(login)) set.add("app", botSlug(login), null, "detected", "merge_authors");
  }
  return set;
}

export function finaliseIdentities(set: IdentitySet, appIds: Map<string, number>): AgentIdentity[] {
  for (const id of set.list()) {
    if (id.kind === "app" && id.slug !== undefined && id.appId === undefined) {
      const found = appIds.get(id.slug.toLowerCase());
      if (found !== undefined) id.appId = found;
    }
  }
  set.mergeByAppId();
  const out = set.list().map((i) => ({ ...i, foundIn: [...i.foundIn].sort() }));
  const key = (i: AgentIdentity) => `${i.kind}\u0000${(i.login ?? i.slug ?? `~${i.appId}`).toLowerCase()}`;
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Does this login (a PR author, a CODEOWNERS user owner without the @, a collaborator) belong to an agent identity? */
export function matchLogin(ids: readonly AgentIdentity[], login: string): AgentIdentity | undefined {
  const l = login.toLowerCase();
  return ids.find((i) => {
    if (i.kind === "user") return (i.login ?? "").toLowerCase() === l;
    return i.slug !== undefined && `${i.slug.toLowerCase()}[bot]` === l;
  });
}
