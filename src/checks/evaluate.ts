// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { type Ownership as FileOwnership, ownerKind, ownersOf, parseCodeowners } from "../codeowners.js";
import {
  type GateSet,
  MAX_CANDIDATE_READS,
  gateFilesIn,
  isCandidatePath,
  isGatePathForChange,
  probePaths,
} from "../gates.js";
import type { ReadResult } from "../github/client.js";
import type { RulesetRolesRead } from "../github/graphql.js";
import {
  type MergeCandidates,
  type PullDetail,
  type Snapshot,
  codeownersErrorsInUse,
  errorLines,
  ownerType,
} from "../github/snapshot.js";
import type { AppData, InstallationData, OrgMembershipData } from "../github/types.js";
import { type AgentIdentity, type AppIdConflict, type AppSlugShare, appLabel, identityName, matchLogin } from "../identities.js";
import { type Setting, pullRequestRequired, reviewSetting, statusChecks } from "../protection.js";
import { ReasonList, reason } from "./reasons.js";
import { CHECK_IDS, CHECK_TITLES, type CheckId, type CheckRow, type CheckStatus } from "./types.js";

export interface EvalInput {
  snap: Snapshot;
  identities: AgentIdentity[];
  gates: GateSet;
  /**
   * Check 6's gate set: `gates` without the candidates judged at the head,
   * since check 6 judges candidates at each merge.
   */
  changeGates: GateSet;
  pullDetails: Map<number, PullDetail>;
  /** Each agent pull request's changed candidate files, read at its merge. */
  mergeCandidates: Map<number, MergeCandidates>;
  /** `GET /apps/{slug}` for each app identity's slug, keyed by the slug in lower case. */
  appLookups: Map<string, ReadResult<AppData>>;
  /** App slugs declared with more than one id. */
  appIdConflicts?: AppIdConflict[];
  /** App ids that two different declared slugs resolve to. */
  appSlugsSharingId?: AppSlugShare[];
  /**
   * `GET /orgs/{org}/memberships/{username}` for each admin user agent, keyed by
   * login in lower case, read only when an OrganizationAdmin bypass is in
   * effect on an organisation's repository.
   */
  orgMemberships?: Map<string, ReadResult<OrgMembershipData>>;
  /**
   * `GET /orgs/{org}/installations`, read when an agent app exists and an
   * organisation owns the repository. Undefined when not read.
   */
  orgInstallations?: ReadResult<InstallationData[]>;
  /**
   * Role names of ruleset bypass actors, from the opt-in GraphQL reader.
   * Undefined when the reader did not run; `roles` is null when it ran and
   * its read failed or was incomplete.
   */
  rulesetRoles?: RulesetRolesRead;
}

function makeRow(
  id: CheckId,
  status: CheckStatus,
  reasons: ReturnType<ReasonList["list"]>,
  read: Iterable<string>,
  context: string[] = [],
  details?: Record<string, unknown>,
): CheckRow {
  const row: CheckRow = {
    id,
    title: CHECK_TITLES[id],
    status,
    reasons,
    read: [...new Set(read)],
    context,
  };
  if (details !== undefined) row.details = details;
  return row;
}

/** fail if any fail reason, else unverifiable if any unknown, else pass. */
function decide(fails: ReasonList, unknowns: ReasonList, order: readonly string[]) {
  if (fails.size > 0) return { status: "fail" as const, reasons: fails.list(order) };
  if (unknowns.size > 0) return { status: "unverifiable" as const, reasons: unknowns.list(order) };
  return { status: "pass" as const, reasons: [] };
}

function addSettingUnknown(unknowns: ReasonList, s: Setting) {
  for (const c of s.causes) {
    if (c === "field_missing") unknowns.add(c, ...s.missingFields);
    else unknowns.add(c);
  }
}

function configUnknown(snap: Snapshot, unknowns: ReasonList, read: string[]) {
  const c = snap.config;
  if (c.state === "not_read") return;
  read.push(c.endpoint);
  if (c.state === "invalid") unknowns.add("config_invalid", c.problem);
  if (c.state === "unreadable") unknowns.add("config_unreadable");
}

interface Ownership {
  /** Gate files in the tree, or null when the inventory is incomplete or unknown. */
  gateFiles: string[] | null;
  /**
   * Each gate file's owners under the CODEOWNERS file in use, computed once for
   * checks 1 and 3. Null when there is no CODEOWNERS file or gateFiles is null.
   */
  owners: Map<string, FileOwnership> | null;
  /**
   * Each probe path's owners: paths not in the tree that would change the
   * gate if added (gates.ts, probePaths). Empty when there is no CODEOWNERS
   * file, or the file or the config could not be read.
   */
  probes: Map<string, FileOwnership>;
  codeownersPath: string | null;
  ignored: Array<{ line: number; source: string; kind: string }>;
  /** Candidates (package.json and the like) read and found to hold no test settings. */
  candidatesWithoutTestSettings: string[];
  unknowns: ReasonList;
  read: string[];
}

/** Everything checks 1 and 3 need about the tree and CODEOWNERS. */
function ownership(input: EvalInput): Ownership {
  const { snap } = input;
  const unknowns = new ReasonList();
  const read: string[] = [];
  const out: Ownership = {
    gateFiles: null,
    owners: null,
    probes: new Map(),
    codeownersPath: null,
    ignored: [],
    candidatesWithoutTestSettings: [],
    unknowns,
    read,
  };

  let treePaths: string[] | null = null;
  if (snap.tree) read.push(`GET ${snap.tree.endpoint}`);
  if (!snap.tree || snap.tree.state !== "read") unknowns.add("tree_unreadable");
  else {
    const t = snap.tree.data;
    if (typeof t?.truncated !== "boolean" || !Array.isArray(t.tree)) unknowns.add("field_missing", "tree.truncated");
    else if (t.truncated) unknowns.add("tree_truncated");
    else
      treePaths = t.tree
        .filter((e) => e.type === "blob" && typeof e.path === "string")
        .map((e) => e.path as string);
  }

  const co = snap.codeowners;
  read.push(...co.endpoints);
  let codeownersKnown = false;
  let file: ReturnType<typeof parseCodeowners> | null = null;
  if (co.state === "unreadable") unknowns.add("codeowners_unreadable");
  else if (co.state === "none") codeownersKnown = true;
  else if (co.state === "found") {
    out.codeownersPath = co.path;
    read.push(co.path);
    if (snap.codeownersErrors) read.push(`GET ${snap.codeownersErrors.endpoint}`);
    const errors = codeownersErrorsInUse(snap);
    if (errors === null) unknowns.add("codeowners_errors_unreadable");
    else {
      file = parseCodeowners(co.text, errorLines(errors));
      const kinds = new Map(errors.map((e) => [e.line, e.kind ?? "error"]));
      out.ignored = file.ignoredLines.map((l) => ({ ...l, kind: String(kinds.get(l.line) ?? "error") }));
      codeownersKnown = true;
    }
  }

  // A probe's ownership depends only on its path, so probes are judged even
  // when the tree is unknown; the tree only drops probes that exist.
  if (file !== null && out.codeownersPath !== null && configKnown(snap)) {
    const f = file;
    for (const p of probePaths(input.gates, out.codeownersPath, treePaths)) out.probes.set(p, ownersOf(f, p));
  }

  if (treePaths !== null && codeownersKnown && configKnown(snap)) {
    out.gateFiles = gateFilesIn(input.gates, treePaths);
    const cand = snap.candidates;
    if (cand.state === "over_cap") {
      unknowns.add(
        "gate_candidates_over_cap",
        `${cand.count} candidate files, ${cand.distinct} distinct; at most ${MAX_CANDIDATE_READS} distinct files are read`,
      );
    } else if (cand.state === "read") {
      for (const c of cand.results) read.push(c.endpoint);
      const unreadable = cand.results.filter((c) => c.state === "unreadable").map((c) => c.path);
      if (unreadable.length > 0) unknowns.add("gate_candidate_unreadable", ...unreadable);
      out.candidatesWithoutTestSettings = cand.results.filter((c) => c.state === "not_gate").map((c) => c.path);
    }
    if (file !== null) {
      const f = file;
      out.owners = new Map(out.gateFiles.map((g) => [g, ownersOf(f, g)]));
    }
  }
  return out;
}

function configKnown(snap: Snapshot): boolean {
  return snap.config.state === "valid" || snap.config.state === "absent";
}

const ORDER_1 = [
  "gate_files_unowned",
  "new_gate_paths_unowned",
  "no_codeowners_file",
  "code_owner_review_not_required",
  "tree_unreadable",
  "tree_truncated",
  "codeowners_unreadable",
  "codeowners_errors_unreadable",
  "codeowners_error_ambiguous",
  "gate_candidate_unreadable",
  "gate_candidates_over_cap",
  "config_invalid",
  "config_unreadable",
  "rules_unreadable",
  "classic_protection_unreadable",
  "field_missing",
];

export function checkGateFilesOwned(input: EvalInput, own: Ownership): CheckRow {
  const { snap } = input;
  const fails = new ReasonList();
  const unknowns = new ReasonList();
  const read = [...own.read];
  const context: string[] = [];
  own.unknowns.list().forEach((r) => unknowns.add(r.code, ...(r.subjects ?? [])));
  configUnknown(snap, unknowns, read);

  let teamOwners: string[] = [];
  if (own.gateFiles !== null) {
    const unowned: string[] = [];
    const ambiguous: string[] = [];
    const unresolved = new Set<string>();
    for (const f of own.gateFiles) {
      const o = own.owners?.get(f);
      if (o === undefined) {
        unowned.push(f);
        continue;
      }
      if (o.ambiguous) ambiguous.push(f);
      else if (o.owners.length === 0) unowned.push(f);
      for (const w of o.owners) if (ownerKind(w) !== "user") unresolved.add(w);
    }
    if (unowned.length > 0) fails.add("gate_files_unowned", ...unowned);
    else if (own.gateFiles.length === 0 && own.owners === null) fails.add("no_codeowners_file");
    if (ambiguous.length > 0) unknowns.add("codeowners_error_ambiguous", ...ambiguous);
    teamOwners = [...unresolved];
  }
  const unownedProbes: string[] = [];
  const ambiguousProbes: string[] = [];
  for (const [p, o] of own.probes) {
    if (o.ambiguous) ambiguousProbes.push(p);
    else if (o.owners.length === 0) unownedProbes.push(p);
    for (const w of o.owners) if (ownerKind(w) !== "user") teamOwners.push(w);
  }
  if (unownedProbes.length > 0) fails.add("new_gate_paths_unowned", ...unownedProbes);
  if (ambiguousProbes.length > 0) unknowns.add("codeowners_error_ambiguous", ...ambiguousProbes);
  teamOwners = [...new Set(teamOwners)].sort();

  const cor = reviewSetting(snap, "codeOwnerReview");
  read.push(...cor.read);
  if (cor.value === false) fails.add("code_owner_review_not_required");
  else if (cor.value === null) addSettingUnknown(unknowns, cor);

  if (teamOwners.length > 0) {
    context.push(
      `Gate files are owned by ${teamOwners.join(", ")}, reported as written; their members were not read.`,
    );
  }
  if (own.ignored.length > 0) {
    context.push(
      `GitHub reports ${own.ignored.length} CODEOWNERS line(s) as errors. Owners GitHub flags do not count; a line with an invalid owner or pattern is skipped.`,
    );
  }
  const d = decide(fails, unknowns, ORDER_1);
  const details: Record<string, unknown> = {
    codeownersFile: own.codeownersPath,
    gateFiles: own.gateFiles,
    probedPaths: [...own.probes.keys()],
    ignoredCodeownersLines: own.ignored,
    candidatesWithoutTestSettings: own.candidatesWithoutTestSettings,
  };
  return makeRow("gate_files_owned", d.status, d.reasons, read, context, details);
}

const ORDER_2 = [
  "no_pull_request_rule",
  "approving_review_not_required",
  "stale_reviews_not_dismissed",
  "last_push_approval_not_required",
  "rules_unreadable",
  "classic_protection_unreadable",
  "field_missing",
];

export function checkHumanReviewRequired(input: EvalInput): CheckRow {
  const { snap } = input;
  const fails = new ReasonList();
  const unknowns = new ReasonList();
  const read: string[] = [];
  const pr = pullRequestRequired(snap);
  read.push(...pr.read);
  const settings: Array<[string, Setting]> = [
    ["approving_review_not_required", reviewSetting(snap, "approvingReview")],
    ["stale_reviews_not_dismissed", reviewSetting(snap, "dismissStale")],
    ["last_push_approval_not_required", reviewSetting(snap, "lastPushApproval")],
  ];
  if (pr.value === false) fails.add("no_pull_request_rule");
  else {
    for (const [code, s] of settings) {
      read.push(...s.read);
      if (s.value === false) fails.add(code);
      else if (s.value === null) addSettingUnknown(unknowns, s);
    }
  }
  const d = decide(fails, unknowns, ORDER_2);
  return makeRow("human_review_required", d.status, d.reasons, read);
}

function lookupWhy(r: ReadResult<AppData> | undefined): string {
  if (!r) return "not read";
  if (r.state === "read") return "no app id in the response";
  return r.status === null ? r.state : `${r.state}, ${r.status}`;
}

function andList(items: Array<number | string>): string {
  return items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A declared app whose slug `GET /apps/{slug}` did not resolve: the slug may be
 * misspelt or the read failed, so every check about it may be about no app at all.
 * A slug declared with two ids names no one app. A declared id that
 * the lookup did not confirm still counts, and a context line says so.
 * Two declared slugs with one id name one app at most: the identity keeps one
 * slug, and a bot login under the other matches no identity.
 */
function unresolvedApps(input: EvalInput, unknowns: ReasonList, read: string[], context: string[]) {
  for (const c of input.appIdConflicts ?? []) {
    unknowns.add("agent_app_ids_conflict", `${c.slug} (declared ${andList(c.ids)})`);
  }
  for (const s of input.appSlugsSharingId ?? []) {
    unknowns.add("agent_app_slugs_share_id", `${andList(s.slugs)} (id ${s.id})`);
  }
  for (const id of input.identities) {
    if (id.kind !== "app" || id.source !== "declared" || id.slug === undefined) continue;
    const r = input.appLookups.get(id.slug.toLowerCase());
    if (id.appId !== undefined) {
      // The id is declared, or resolved by the lookup. If the lookup was read and
      // names a different app, the declaration and GitHub disagree.
      const found = r?.state === "read" ? r.data?.id : undefined;
      if (typeof found === "number" && found !== id.appId) {
        if (r) read.push(`GET ${r.endpoint}`);
        unknowns.add("agent_app_id_mismatch", `${id.slug} (declared ${id.appId}, GitHub says ${found})`);
      } else if (typeof found !== "number") {
        // No successful lookup gave this id, so it is the declared one.
        if (r) read.push(`GET ${r.endpoint}`);
        const endpoint = r ? r.endpoint : `/apps/${encodeURIComponent(id.slug)}`;
        const line = `Agent app ${id.slug}: id ${id.appId} is as declared; GET ${endpoint} did not confirm it (${lookupWhy(r)}).`;
        if (!context.includes(line)) context.push(line);
      }
      continue;
    }
    if (r) read.push(`GET ${r.endpoint}`);
    unknowns.add("agent_app_unresolved", `${id.slug} (${lookupWhy(r)})`);
  }
}

/**
 * No agent identities: the row cannot pass. If .github/darz.json could not be
 * used, say so too, since that is where agents would have been declared.
 */
function identitiesUnverifiable(id: CheckId, identities: AgentIdentity[], snap: Snapshot): CheckRow | null {
  if (identities.length > 0) return null;
  const unknowns = new ReasonList().add("no_agent_identities");
  const read: string[] = [];
  configUnknown(snap, unknowns, read);
  return makeRow(id, "unverifiable", unknowns.list(), read);
}

const ORDER_3 = [
  "agent_is_code_owner",
  "last_push_approval_not_required",
  "tree_unreadable",
  "tree_truncated",
  "codeowners_unreadable",
  "codeowners_errors_unreadable",
  "codeowners_error_ambiguous",
  "gate_candidate_unreadable",
  "gate_candidates_over_cap",
  "unresolved_owners",
  "agent_app_unresolved",
  "agent_app_id_mismatch",
  "agent_app_ids_conflict",
  "agent_app_slugs_share_id",
  "config_invalid",
  "config_unreadable",
  "rules_unreadable",
  "classic_protection_unreadable",
  "field_missing",
];

export function checkWriterNotApprover(input: EvalInput, own: Ownership): CheckRow {
  const { snap, identities } = input;
  const empty = identitiesUnverifiable("writer_not_approver", identities, snap);
  if (empty) return empty;
  const fails = new ReasonList();
  const unknowns = new ReasonList();
  const read = [...own.read];
  const context = [
    "GitHub never counts a pull request author's own approval toward required reviews; that is GitHub's behaviour, not this check.",
  ];
  configUnknown(snap, unknowns, read);
  unresolvedApps(input, unknowns, read, context);
  own.unknowns.list().forEach((r) => unknowns.add(r.code, ...(r.subjects ?? [])));

  const lp = reviewSetting(snap, "lastPushApproval");
  read.push(...lp.read);
  if (lp.value === false) fails.add("last_push_approval_not_required");
  else if (lp.value === null) addSettingUnknown(unknowns, lp);

  const hasUserAgent = identities.some((i) => i.kind === "user");
  if (own.owners !== null || own.probes.size > 0) {
    const byAgent = new Map<string, string[]>();
    const unresolved = new Set<string>();
    const ambiguous: string[] = [];
    for (const [f, o] of [...(own.owners ?? []), ...own.probes]) {
      if (o.ambiguous) {
        ambiguous.push(f);
        continue;
      }
      for (const w of o.owners) {
        const kind = ownerKind(w);
        if (kind !== "user") {
          unresolved.add(w);
          continue;
        }
        const agent = matchLogin(identities, w.slice(1));
        if (agent) {
          const name = identityName(agent);
          byAgent.set(name, [...(byAgent.get(name) ?? []), f]);
        }
      }
    }
    for (const [name, files] of [...byAgent.entries()].sort()) {
      fails.add("agent_is_code_owner", `${name}: ${files.join(", ")}`);
    }
    if (ambiguous.length > 0) unknowns.add("codeowners_error_ambiguous", ...ambiguous);
    if (unresolved.size > 0 && hasUserAgent) unknowns.add("unresolved_owners", ...[...unresolved].sort());
  }
  const d = decide(fails, unknowns, ORDER_3);
  return makeRow("writer_not_approver", d.status, d.reasons, read, context);
}

const LEVELS = ["read", "triage", "write", "maintain", "admin"] as const;
type Level = (typeof LEVELS)[number];


const ORDER_4 = [
  "agent_app_can_bypass",
  "agent_app_can_administer",
  "agent_role_can_bypass",
  "agent_is_admin",
  "admins_not_enforced_agent_is_admin",
  "agent_in_bypass_allowance",
  "rules_unreadable",
  "ruleset_unreadable",
  "bypass_list_unreadable",
  "bypass_role_unknown",
  "bypass_role_inheritance_unknown",
  "bypass_role_order_unknown",
  "bypass_actor_unknown",
  "team_bypass_members_unread",
  "collaborators_unreadable",
  "classic_protection_unreadable",
  "field_missing",
  "agent_app_unresolved",
  "agent_app_id_mismatch",
  "agent_app_ids_conflict",
  "agent_app_slugs_share_id",
  "config_invalid",
  "config_unreadable",
];

export function checkAgentsCannotBypass(input: EvalInput): CheckRow {
  const { snap, identities } = input;
  const empty = identitiesUnverifiable("agents_cannot_bypass", identities, snap);
  if (empty) return empty;
  const fails = new ReasonList();
  const unknowns = new ReasonList();
  const read: string[] = [];
  const context: string[] = [];
  configUnknown(snap, unknowns, read);
  unresolvedApps(input, unknowns, read, context);
  const hasUserAgent = identities.some((i) => i.kind === "user");

  // Agent permission levels, from the collaborators list.
  const levels = new Map<AgentIdentity, Level | null>();
  /** Each agent collaborator's role_name, which may be a custom role. */
  const roleNames = new Map<AgentIdentity, string>();
  let collaboratorsKnown = false;
  if (snap.collaborators) read.push(`GET ${snap.collaborators.endpoint}`);
  if (snap.collaborators?.state === "read") {
    collaboratorsKnown = true;
    for (const id of identities) levels.set(id, null);
    for (const c of snap.collaborators.data ?? []) {
      if (typeof c.login !== "string") continue;
      const agent = matchLogin(identities, c.login);
      if (!agent) continue;
      levels.set(agent, levelOf(c));
      if (typeof c.role_name === "string" && c.role_name.length > 0) roleNames.set(agent, c.role_name);
    }
  } else {
    unknowns.add("collaborators_unreadable");
  }
  const atLeast = (lvl: Level) =>
    identities.filter((i) => {
      const l = levels.get(i);
      return l !== undefined && l !== null && LEVELS.indexOf(l) >= LEVELS.indexOf(lvl);
    });

  if (snap.rules) read.push(`GET ${snap.rules.endpoint}`);
  if (input.rulesetRoles) read.push(input.rulesetRoles.endpoint);
  if (snap.rules?.state !== "read") unknowns.add("rules_unreadable");
  else {
    for (const [id, rs] of snap.rulesets) {
      read.push(`GET ${rs.endpoint}`);
      if (rs.state !== "read") {
        unknowns.add("ruleset_unreadable", `ruleset ${id}`);
        continue;
      }
      const actors = rs.data?.bypass_actors;
      if (!Array.isArray(actors)) {
        unknowns.add("bypass_list_unreadable", `ruleset ${id}`);
        continue;
      }
      // Looked up only when a role bypass needs a name, so the row's context
      // speaks of role names only where they could have changed its answer.
      let cached: { names: Map<number, string> | undefined } | undefined;
      const names = () => (cached ??= { names: roleNamesFor(input, id, actors, context) }).names;
      for (const a of actors) {
        const where = `ruleset ${id}`;
        switch (a.actor_type) {
          case "Integration": {
            const agent = identities.find((i) => i.kind === "app" && i.appId === a.actor_id);
            const label = agent ? appLabel(agent) : `app id ${a.actor_id}`;
            fails.add("agent_app_can_bypass", `${label} on ${where}`);
            break;
          }
          case "RepositoryRole": {
            // GitHub does not document which actor_id is which built-in
            // repository role, so Darz cannot tell whether a role
            // bypass covers an agent's permission. Any agent that holds a
            // repository permission might hold the role, so the row cannot pass.
            if (!collaboratorsKnown) break;
            const holders = identities.filter((i) => {
              const l = levels.get(i);
              return l !== undefined && l !== null;
            });
            if (holders.length === 0) break;
            // With --graphql-ruleset-roles, GitHub names the role. Without it, or
            // when that read could not be matched to REST's, the role is unknown.
            const roleName = typeof a.actor_id === "number" ? names()?.get(a.actor_id) : undefined;
            if (roleName === undefined) {
              const who = holders.map((h) => `${identityName(h)} has ${levels.get(h)}`).join(", ");
              unknowns.add("bypass_role_unknown", `role id ${a.actor_id} on ${where}; ${who}`);
              break;
            }
            const roleLevel = builtinLevel(roleName);
            for (const h of holders) {
              const agentRole = roleNames.get(h) ?? (levels.get(h) as Level);
              const agentLevel = builtinLevel(agentRole);
              if (agentRole.toLowerCase() === roleName.toLowerCase()) {
                fails.add("agent_role_can_bypass", `${identityName(h)} holds the ${roleName} role, which can bypass ${where}`);
              } else if (roleLevel !== null && agentLevel !== null) {
                // A lower role does not hold a higher one. Whether a role's bypass
                // covers the roles above it is not documented.
                if (LEVELS.indexOf(agentLevel) > LEVELS.indexOf(roleLevel)) {
                  unknowns.add(
                    "bypass_role_inheritance_unknown",
                    `${identityName(h)} has ${agentRole}; the ${roleName} role can bypass ${where}`,
                  );
                }
              } else {
                unknowns.add("bypass_role_order_unknown", `role ${roleName} on ${where}; ${identityName(h)} has ${agentRole}`);
              }
            }
            break;
          }
          case "OrganizationAdmin": {
            if (!collaboratorsKnown) break;
            orgAdminCoverage(input, where, atLeast("admin"), fails, read, context);
            break;
          }
          case "Team":
            if (hasUserAgent) unknowns.add("team_bypass_members_unread", `team id ${a.actor_id} on ${where}`);
            else context.push(`Team id ${a.actor_id} can bypass ${where}; its members were not read.`);
            break;
          case "DeployKey":
            context.push(`Deploy keys can bypass ${where}.`);
            break;
          default:
            unknowns.add("bypass_actor_unknown", `${String(a.actor_type)} on ${where}`);
        }
      }
    }
  }

  const admins = collaboratorsKnown ? atLeast("admin") : [];
  for (const a of admins) fails.add("agent_is_admin", identityName(a));

  const c = snap.classic;
  if (c && c.endpoint) read.push(c.endpoint);
  if (!c || c.state === "unreadable") unknowns.add("classic_protection_unreadable");
  else if (c.state === "present") {
    const enforced = c.data.enforce_admins?.enabled;
    if (admins.length > 0) {
      if (enforced === false) for (const a of admins) fails.add("admins_not_enforced_agent_is_admin", identityName(a));
      else if (typeof enforced !== "boolean") unknowns.add("field_missing", "classic.enforce_admins.enabled");
    }
    const reviews = c.data.required_pull_request_reviews;
    if (reviews) {
      // GitHub leaves bypass_pull_request_allowances out when there are none
      // (seen on a live repository); a value of another shape is unknown.
      const allow = reviews.bypass_pull_request_allowances;
      if (allow !== undefined && (allow === null || typeof allow !== "object")) {
        unknowns.add("field_missing", "classic.required_pull_request_reviews.bypass_pull_request_allowances");
      } else if (allow !== undefined) {
        for (const u of allow.users ?? []) {
          const agent = typeof u.login === "string" ? matchLogin(identities, u.login) : undefined;
          if (agent) fails.add("agent_in_bypass_allowance", identityName(agent));
        }
        for (const app of allow.apps ?? []) {
          const agent = identities.find(
            (i) =>
              i.kind === "app" &&
              ((app.slug !== undefined && i.slug?.toLowerCase() === app.slug.toLowerCase()) ||
                (app.id !== undefined && i.appId === app.id)),
          );
          if (agent) fails.add("agent_in_bypass_allowance", appLabel(agent));
        }
        if ((allow.teams ?? []).length > 0 && hasUserAgent) {
          unknowns.add("team_bypass_members_unread", ...(allow.teams ?? []).map((t) => `team ${t.slug} in classic bypass allowance`));
        }
      }
    }
  }
  installationPermissions(input, fails, unknowns, read, context);
  const d = decide(fails, unknowns, ORDER_4);
  return makeRow("agents_cannot_bypass", d.status, d.reasons, read, context);
}

/**
 * Installation permissions that let an app change what protects the default
 * branch. administration: write edits and deletes repository rulesets and
 * classic branch protection, and sets collaborators' roles;
 * organization_administration: write edits and deletes organisation rulesets.
 * GitHub's "Permissions required for GitHub Apps" lists those endpoints under
 * these two permissions.
 */
const ADMINISTER_PERMISSIONS: Record<string, readonly string[]> = {
  administration: ["write"],
  organization_administration: ["write"],
};

/**
 * Permissions that can move a repository out of an organisation ruleset that
 * selects repositories by custom property. Whether one does depends on the
 * ruleset's conditions, which Darz does not judge, so these are context.
 */
const PROPERTY_PERMISSIONS: Record<string, readonly string[]> = {
  repository_custom_properties: ["write"],
  organization_custom_properties: ["write", "admin"],
};

const INSTALLATIONS_NOT_CHECKED = "GitHub App installation permissions of agent apps were not checked";

/**
 * Check 4: an agent app whose installation can administer the
 * repository or the organisation can remove the rules that bind it.
 *
 * The list is readable only with an organisation owner's token, or
 * organisation Administration: read. The GitHub Actions workflow token never
 * can, and no user token can read a personal account's installations. When it
 * cannot be read, a context line says so and the row is decided as it would be
 * without it: a reason would make check 4 unverifiable on every run with the
 * default token.
 *
 * An installation on selected repositories is taken to cover this one: an
 * agent app acts on this repository, which it can do only if installed on it.
 */
function installationPermissions(
  input: EvalInput,
  fails: ReasonList,
  unknowns: ReasonList,
  read: string[],
  context: string[],
) {
  const apps = input.identities.filter((i) => i.kind === "app");
  if (apps.length === 0) return;
  const org = input.snap.owner;
  const type = ownerType(input.snap);
  if (type === "User") {
    context.push(
      `${INSTALLATIONS_NOT_CHECKED}: the repository is owned by a user, and a user's installations can be read only with a GitHub App's own credentials.`,
    );
    return;
  }
  if (type === null) {
    context.push(`${INSTALLATIONS_NOT_CHECKED}: the repository owner's account type was not read.`);
    return;
  }
  const r = input.orgInstallations;
  if (!r) {
    context.push(`${INSTALLATIONS_NOT_CHECKED}: GET /orgs/${org}/installations was not read.`);
    return;
  }
  read.push(`GET ${r.endpoint}`);
  if (r.state !== "read") {
    const why = r.status === null ? r.state : `${r.state}, ${r.status}`;
    context.push(
      `${INSTALLATIONS_NOT_CHECKED}: GET ${r.endpoint} was ${why}. Reading it needs an organisation owner's token, or organisation Administration: read; the GitHub Actions workflow token cannot.`,
    );
    return;
  }
  const installations = r.data ?? [];
  for (const agent of apps) {
    const name = agent.slug ?? `id ${agent.appId}`;
    const inst = installations.find((i) =>
      agent.appId !== undefined
        ? i?.app_id === agent.appId
        : agent.slug !== undefined && typeof i?.app_slug === "string" && i.app_slug.toLowerCase() === agent.slug.toLowerCase(),
    );
    if (!inst) {
      pushOnce(context, `Agent app ${name} has no installation on organisation ${org}, so it holds no installation permissions on this repository.`);
      continue;
    }
    const perms = inst.permissions;
    if (typeof perms !== "object" || perms === null || Array.isArray(perms)) {
      unknowns.add("field_missing", `installations[${agent.appId !== undefined ? `app_id=${agent.appId}` : `app_slug=${agent.slug}`}].permissions`);
      continue;
    }
    const where = `installation ${inst.id ?? "?"}, repository_selection ${inst.repository_selection ?? "?"}`;
    for (const [perm, levels] of Object.entries(ADMINISTER_PERMISSIONS)) {
      const level = perms[perm];
      if (typeof level === "string" && levels.includes(level)) {
        fails.add("agent_app_can_administer", `${appLabel(agent)}: ${perm}: ${level} (${where})`);
      }
    }
    for (const [perm, levels] of Object.entries(PROPERTY_PERMISSIONS)) {
      const level = perms[perm];
      if (typeof level === "string" && levels.includes(level)) {
        pushOnce(
          context,
          `Agent app ${name}'s installation has ${perm}: ${level}. An organisation ruleset that selects repositories by custom property could stop applying to this repository if its property values change; Darz does not judge this.`,
        );
      }
    }
  }
}

function pushOnce(lines: string[], line: string) {
  if (!lines.includes(line)) lines.push(line);
}

/**
 * An OrganizationAdmin bypass covers the owners of the organisation that owns
 * the repository, not every repository admin. Only a person can be
 * an owner: an app agent is never covered. GitHub says the actor
 * type is not applicable for personal repositories.
 *
 * Every agent passed here has admin permission, so the row already fails with
 * agent_is_admin. An unknown membership is therefore a context line: an
 * unverifiable reason could never show beside a fail. Coverage is claimed
 * only when GitHub says the agent is an active owner.
 */
function orgAdminCoverage(
  input: EvalInput,
  where: string,
  admins: AgentIdentity[],
  fails: ReasonList,
  read: string[],
  context: string[],
) {
  const org = input.snap.owner;
  const type = ownerType(input.snap);
  if (type === "User") {
    pushOnce(
      context,
      `OrganizationAdmin can bypass ${where}; GitHub says that actor type is not applicable for personal repositories, so it covers no agent.`,
    );
    return;
  }
  for (const agent of admins) {
    if (agent.kind !== "user" || agent.login === undefined) continue;
    const name = identityName(agent);
    const r = type === "Organization" ? input.orgMemberships?.get(agent.login.toLowerCase()) : undefined;
    if (r) read.push(`GET ${r.endpoint}`);
    const role = r?.state === "read" ? r.data?.role : undefined;
    const state = r?.state === "read" ? r.data?.state : undefined;
    if (typeof role === "string" && typeof state === "string") {
      if (role === "admin" && state === "active") {
        fails.add("agent_role_can_bypass", `${name} is an organisation owner, covered by organisation admin bypass on ${where}`);
      } else {
        pushOnce(
          context,
          `${name} is a repository admin but not an owner of organisation ${org}, so the organisation admin bypass on ${where} does not cover it.`,
        );
      }
      continue;
    }
    let why: string;
    if (type === null) why = "the repository owner's account type was not read";
    else if (!r) why = `GET /orgs/${org}/memberships/${agent.login} was not read`;
    else if (r.state === "read") why = `GET ${r.endpoint} gave no role or state`;
    else why = `GET ${r.endpoint} was ${r.status === null ? r.state : `${r.state}, ${r.status}`}`;
    if (r?.status === 404) why += "; GitHub answers 404 both for a user who is not a member and for a membership the token cannot see";
    pushOnce(
      context,
      `Whether ${name} is an owner of organisation ${org}, and so covered by the organisation admin bypass on ${where}, is unknown: ${why}. The row fails on agent_is_admin either way.`,
    );
  }
}

/**
 * The admin user agents whose organisation membership check 4 needs: the
 * repository belongs to an organisation, the effective rules and the
 * collaborators list were read, and a ruleset that was read names an
 * OrganizationAdmin bypass actor. Logins as the collaborators list spells them.
 */
export function orgMembershipLogins(snap: Snapshot, identities: AgentIdentity[]): string[] {
  if (ownerType(snap) !== "Organization") return [];
  if (snap.rules?.state !== "read" || snap.collaborators?.state !== "read") return [];
  const orgAdmin = [...snap.rulesets.values()].some(
    (rs) =>
      rs.state === "read" &&
      Array.isArray(rs.data?.bypass_actors) &&
      rs.data.bypass_actors.some((a) => a?.actor_type === "OrganizationAdmin"),
  );
  if (!orgAdmin) return [];
  const out = new Map<string, string>();
  for (const c of snap.collaborators.data ?? []) {
    if (typeof c.login !== "string") continue;
    const agent = matchLogin(identities, c.login);
    if (agent?.kind === "user" && levelOf(c) === "admin") out.set(c.login.toLowerCase(), c.login);
  }
  return [...out.values()].sort();
}

/**
 * Whether check 4 could use ruleset role names from GraphQL: the effective
 * rules were read, a ruleset that was read names a repository role as a
 * bypass actor, and an agent identity holds a repository permission in the
 * collaborators list that was read. Otherwise check 4 decides without names,
 * and the opt-in GraphQL read is not sent.
 */
export function roleNamesCanMatter(snap: Snapshot, identities: AgentIdentity[]): boolean {
  if (snap.rules?.state !== "read" || snap.collaborators?.state !== "read") return false;
  const roleBypass = [...snap.rulesets.values()].some(
    (rs) =>
      rs.state === "read" &&
      Array.isArray(rs.data?.bypass_actors) &&
      rs.data.bypass_actors.some((a) => a?.actor_type === "RepositoryRole"),
  );
  if (!roleBypass) return false;
  return (snap.collaborators.data ?? []).some(
    (c) => typeof c.login === "string" && matchLogin(identities, c.login) !== undefined && levelOf(c) !== null,
  );
}

/**
 * The role names GraphQL gives for one ruleset's repository-role bypass
 * actors, keyed by REST's actor_id; undefined when they cannot be used.
 *
 * GitHub does not document that GraphQL's repositoryRoleDatabaseId is REST's
 * actor_id. So the names are used only when the ruleset's GraphQL role ids are
 * exactly its REST role actor_ids: a ruleset where the two lists differ is
 * unknown, never matched by a wrong name. When the reader ran and its names
 * are not used, a context line says why.
 */
function roleNamesFor(
  input: EvalInput,
  id: number,
  actors: Array<{ actor_type?: unknown; actor_id?: unknown }>,
  context: string[],
): Map<number, string> | undefined {
  const rest = actors.filter((a) => a.actor_type === "RepositoryRole");
  if (!input.rulesetRoles || rest.length === 0) return undefined;
  const note = (why: string) => {
    const line = `Role names from --graphql-ruleset-roles were not used for ruleset ${id}: ${why}.`;
    if (!context.includes(line)) context.push(line);
    return undefined;
  };
  const roles = input.rulesetRoles.roles;
  if (roles === null) return note("the GraphQL read failed or was incomplete");
  const named = roles.get(id);
  if (named === undefined) return note("the GraphQL read did not return it");
  if (named === null) return note("its GraphQL bypass actors were not fully read");
  const restIds = new Set(rest.map((a) => a.actor_id));
  const same = restIds.size === named.size && [...restIds].every((x) => typeof x === "number" && named.has(x));
  if (!same) return note("its role ids in GraphQL and REST differ");
  return named;
}

/** A built-in repository role by name, case-insensitive; null for a custom role. */
function builtinLevel(name: string): Level | null {
  const n = name.toLowerCase();
  return (LEVELS as readonly string[]).includes(n) ? (n as Level) : null;
}

function levelOf(c: { permissions?: Record<string, boolean | undefined>; role_name?: string }): Level | null {
  const p = c.permissions;
  if (p) {
    if (p.admin) return "admin";
    if (p.maintain) return "maintain";
    if (p.push) return "write";
    if (p.triage) return "triage";
    if (p.pull) return "read";
  }
  const r = c.role_name;
  return (LEVELS as readonly string[]).includes(r ?? "") ? (r as Level) : null;
}

/**
 * Check 5. A required check only fails closed if a named app must report it:
 * an unpinned check can be satisfied by anyone who can post a status or check
 * run with that name, an agent included. Every required check must be pinned,
 * none to an agent app. A source Darz could not read could pin a check or
 * require another one, so with a source unreadable the row cannot pass.
 */
export function checkRequiredChecks(input: EvalInput): CheckRow {
  const sc = statusChecks(input.snap);
  const fails = new ReasonList();
  const unknowns = new ReasonList();
  const read = [...sc.read];
  const context: string[] = [];
  const unknownCauses = () => {
    for (const c of sc.causes) {
      if (c === "field_missing") unknowns.add(c, ...sc.missingFields);
      else unknowns.add(c);
    }
  };
  if (sc.anyRequired === false) fails.add("no_required_checks");
  else if (sc.anyRequired === null) unknownCauses();
  else {
    for (const check of sc.checks) {
      for (const appId of check.appIds) {
        const agent = input.identities.find((i) => i.kind === "app" && i.appId === appId);
        if (agent) fails.add("required_check_pinned_to_agent_app", `${check.context}: ${appLabel(agent)}`);
      }
    }
    const unpinned = sc.checks.filter((c) => c.appIds.length === 0).map((c) => c.context);
    if (unpinned.length > 0 && !sc.incomplete) fails.add("required_check_unpinned", ...unpinned);
    if (sc.incomplete) unknownCauses();
    // A pinned check could be pinned to an agent app that Darz cannot name:
    // none is known, a declared app's id is unknown or contradicted, or the
    // config that declares them could not be used. Then the row cannot pass.
    if (sc.checks.some((c) => c.appIds.length > 0)) {
      if (input.identities.length === 0) unknowns.add("no_agent_identities");
      configUnknown(input.snap, unknowns, read);
      unresolvedApps(input, unknowns, read, context);
    }
  }
  const d = decide(fails, unknowns, [
    "no_required_checks",
    "required_check_pinned_to_agent_app",
    "required_check_unpinned",
    "rules_unreadable",
    "classic_protection_unreadable",
    "field_missing",
    "no_agent_identities",
    "agent_app_unresolved",
    "agent_app_id_mismatch",
    "agent_app_ids_conflict",
    "agent_app_slugs_share_id",
    "config_invalid",
    "config_unreadable",
  ]);
  const details = { requiredChecks: sc.checks, mustBeUpToDate: sc.strict === null ? "unknown" : sc.strict };
  return makeRow("required_checks_fail_closed", d.status, d.reasons, read, context, details);
}

/** GitHub's list of a pull request's files stops at 3,000 entries without saying so. */
export const PULL_REQUEST_FILES_CAP = 3000;

export function checkAgentMerges(input: EvalInput): CheckRow {
  const { snap, identities } = input;
  const empty = identitiesUnverifiable("agent_merges_touching_gates", identities, snap);
  if (empty) return empty;
  const unknowns = new ReasonList();
  const read: string[] = [];
  const context: string[] = ["Counts and links only; no judgement of intent."];
  configUnknown(snap, unknowns, read);
  unresolvedApps(input, unknowns, read, context);
  const m = snap.merges;
  if (m.pulls) read.push(...(m.pulls.pageEndpoints ?? [m.pulls.endpoint]).map((e) => `GET ${e}`));
  if (m.pulls?.state !== "read") {
    unknowns.add("merges_unreadable");
    const d = decide(new ReasonList(), unknowns, ["merges_unreadable", "agent_app_unresolved"]);
    return makeRow("agent_merges_touching_gates", d.status, d.reasons, read, context);
  }
  if (m.pulls.capped) {
    const n = m.requested === 1 ? "1 merged pull request" : `${m.requested} merged pull requests`;
    unknowns.add("merges_incomplete", `${m.pulls.pages ?? m.pageCap} pages read, the cap for ${n}`);
  }
  const prs: Array<Record<string, unknown>> = [];
  for (const p of m.merged) {
    const login = p.user?.login;
    if (typeof login !== "string" || !matchLogin(identities, login)) continue;
    const n = p.number as number;
    const detail = input.pullDetails.get(n);
    let gateFilesChanged: string[] | null = null;
    let candidatesUnknown: string[] | null = null;
    let approvers: string[] | null = null;
    let fileListTruncated = false;
    if (detail) {
      read.push(`GET ${detail.files.endpoint}`, `GET ${detail.reviews.endpoint}`);
      if (detail.files.state === "read") {
        const changed = new Set<string>();
        const unknown = new Set<string>();
        const list = detail.files.data ?? [];
        if (list.length >= PULL_REQUEST_FILES_CAP) {
          fileListTruncated = true;
          unknowns.add("pull_request_files_truncated", `#${n}`);
        }
        const mc = input.mergeCandidates.get(n);
        if (mc?.state === "read") read.push(...mc.endpoints);
        for (const f of list) {
          for (const path of [f.filename, f.previous_filename]) {
            if (typeof path !== "string") continue;
            if (isGatePathForChange(input.changeGates, path)) changed.add(path);
            else if (isCandidatePath(path)) {
              // A candidate is a gate file if it held test settings at the merge.
              if (mc?.state === "over_cap") {
                unknown.add(path);
                unknowns.add("gate_candidates_at_merge_over_cap", `#${n}`);
                continue;
              }
              const c = mc?.state === "read" ? mc.results.find((x) => x.path === path) : undefined;
              if (c?.state === "gate") changed.add(path);
              else if (c?.state !== "not_gate") {
                unknown.add(path);
                unknowns.add("gate_candidate_at_merge_unreadable", `#${n}: ${path} (${c?.why ?? "not read"})`);
              }
            }
          }
        }
        gateFilesChanged = [...changed].sort();
        candidatesUnknown = [...unknown].sort();
      } else unknowns.add("pull_request_files_unreadable", `#${n}`);
      if (detail.reviews.state === "read") approvers = latestApprovers(detail.reviews.data ?? []);
      else unknowns.add("pull_request_reviews_unreadable", `#${n}`);
    } else {
      unknowns.add("pull_request_files_unreadable", `#${n}`);
    }
    prs.push({
      number: n,
      url: typeof p.html_url === "string" ? p.html_url : null,
      author: login,
      mergedAt: p.merged_at ?? null,
      gateFilesChanged,
      candidatesUnknown,
      fileListTruncated,
      approvers,
    });
  }
  if (m.merged.length < m.requested) {
    context.push(`${m.merged.length} merged pull requests were read; ${m.requested} were requested.`);
  }
  const details = {
    requested: m.requested,
    mergedRead: m.merged.length,
    agentMerges: prs.length,
    agentMergesTouchingGates: prs.filter((p) => Array.isArray(p.gateFilesChanged) && p.gateFilesChanged.length > 0).length,
    pullRequests: prs,
  };
  const status: CheckStatus = unknowns.size > 0 ? "unverifiable" : "context";
  const reasons = unknowns.list([
    "merges_unreadable",
    "merges_incomplete",
    "pull_request_files_unreadable",
    "pull_request_files_truncated",
    "gate_candidate_at_merge_unreadable",
    "gate_candidates_at_merge_over_cap",
    "pull_request_reviews_unreadable",
    "agent_app_unresolved",
    "agent_app_id_mismatch",
    "agent_app_ids_conflict",
    "agent_app_slugs_share_id",
    "config_invalid",
    "config_unreadable",
  ]);
  return makeRow("agent_merges_touching_gates", status, reasons, read, context, details);
}

/** Each reviewer's latest review that sets a state; COMMENTED and PENDING do not. */
export function latestApprovers(reviews: Array<{ user?: { login?: string } | null; state?: string }>): string[] {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    const login = r.user?.login;
    if (typeof login !== "string" || typeof r.state !== "string") continue;
    if (r.state === "COMMENTED" || r.state === "PENDING") continue;
    latest.set(login, r.state);
  }
  return [...latest.entries()].filter(([, s]) => s === "APPROVED").map(([l]) => l).sort();
}

export function repositoryUnreadableRows(snap: Snapshot): CheckRow[] {
  return CHECK_IDS.map((id) => makeRow(id, "unverifiable", [reason("repository_unreadable")], [snap.repoEndpoint]));
}

export function evaluate(input: EvalInput): CheckRow[] {
  if (!input.snap.repositoryReadable) return repositoryUnreadableRows(input.snap);
  const own = ownership(input);
  return [
    checkGateFilesOwned(input, own),
    checkHumanReviewRequired(input),
    checkWriterNotApprover(input, own),
    checkAgentsCannotBypass(input),
    checkRequiredChecks(input),
    checkAgentMerges(input),
  ];
}
