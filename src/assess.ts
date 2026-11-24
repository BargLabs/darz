// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { evaluate, orgMembershipLogins, roleNamesCanMatter } from "./checks/evaluate.js";
import type { CheckRow } from "./checks/types.js";
import { type FetchLike, GitHubClient, type ReadLogEntry, type ReadResult } from "./github/client.js";
import type { AppData, InstallationData, OrgMembershipData } from "./github/types.js";
import { GraphQLReader, type RulesetRolesRead, readRulesetRoles } from "./github/graphql.js";
import {
  type MergeCandidates,
  type PullDetail,
  candidateChanges,
  ownerType,
  readApp,
  readCandidatesAtMerges,
  readOrgInstallations,
  readOrgMembership,
  readPullDetail,
  readSnapshot,
} from "./github/snapshot.js";
import { gateSet } from "./gates.js";
import { type AgentIdentity, type AppIdConflict, type AppSlugShare, collectIdentities, finaliseIdentities, matchLogin } from "./identities.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

export interface AssessOptions {
  /** `owner/name` */
  repo: string;
  fetch: FetchLike;
  apiUrl?: string;
  token?: string;
  agents?: string[];
  agentApps?: string[];
  gates?: string[];
  merges?: number;
  now?: () => Date;
  /**
   * Read ruleset bypass role names with GitHub's GraphQL API: the one
   * exception to GET only (POST, compiled query documents, never a mutation).
   * Even when asked for, the read is made only if check 4 can use it: a
   * ruleset that was read has a repository-role bypass actor, and an agent
   * identity holds a repository permission.
   */
  graphqlRulesetRoles?: boolean;
}

/** A read as the record lists it: the client's log entry, with the endpoint prefixed by `GET `. */
export type ReadEntry = ReadLogEntry;

export interface Assessment {
  repository: string;
  apiUrl: string;
  repositoryReadable: boolean;
  defaultBranch: string | null;
  commitSha: string | null;
  codeownersPath: string | null;
  /** Where a SARIF result about a setting is located: .github/CODEOWNERS if it exists, else README.md. */
  settingsLocation: string;
  classicProtection: {
    state: "present" | "absent" | "unreadable" | "not_read";
    basis: "read" | "branch_not_protected" | "admin_token_with_repo_scope" | "not_permitted_or_error" | "not_read";
  };
  readAt: string;
  reads: ReadEntry[];
  identities: AgentIdentity[];
  checks: CheckRow[];
}

export const DEFAULT_MERGES = 50;

export function parseRepo(repo: string): { owner: string; name: string } | null {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(repo);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { owner: m[1] as string, name: m[2] as string };
}

export async function assess(o: AssessOptions): Promise<Assessment> {
  const parsed = parseRepo(o.repo);
  if (!parsed) throw new Error(`not an owner/name repository: ${o.repo}`);
  const merges = o.merges ?? DEFAULT_MERGES;
  const readAt = (o.now ?? (() => new Date()))().toISOString().replace(/\.\d{3}Z$/, "Z");
  const client = new GitHubClient({
    fetch: o.fetch,
    ...(o.apiUrl !== undefined ? { apiUrl: o.apiUrl } : {}),
    ...(o.token !== undefined ? { token: o.token } : {}),
    userAgent: `${TOOL_NAME}/${TOOL_VERSION}`,
  });

  const snap = await readSnapshot(client, { ...parsed, merges });
  const flags = { agents: o.agents ?? [], agentApps: o.agentApps ?? [] };

  const configGates = snap.config.state === "valid" ? snap.config.config.gates : [];
  const codeownersPath = snap.codeowners.state === "found" ? snap.codeowners.path : null;
  const globs = [...(o.gates ?? []), ...configGates];
  // Check 6 judges candidate files at each merge, so its gate set leaves out
  // the candidates judged at the head.
  const changeGates = gateSet(globs, codeownersPath);

  let identities: AgentIdentity[] = [];
  const pullDetails = new Map<number, PullDetail>();
  let mergeCandidates = new Map<number, MergeCandidates>();
  const appLookups = new Map<string, ReadResult<AppData>>();
  let appIdConflicts: AppIdConflict[] = [];
  let appSlugsSharingId: AppSlugShare[] = [];
  const orgMemberships = new Map<string, ReadResult<OrgMembershipData>>();
  let orgInstallations: ReadResult<InstallationData[]> | undefined;
  if (snap.repositoryReadable) {
    const set = collectIdentities(snap, flags);
    appIdConflicts = set.appIdConflicts();
    const slugs = [
      ...new Set(set.list().flatMap((id) => (id.kind === "app" && id.slug !== undefined ? [id.slug.toLowerCase()] : []))),
    ];
    const apps = await Promise.all(slugs.map((slug) => readApp(client, slug)));
    const appIds = new Map<string, number>();
    slugs.forEach((slug, i) => {
      const r = apps[i] as ReadResult<AppData>;
      appLookups.set(slug, r);
      if (r.state === "read" && typeof r.data?.id === "number") appIds.set(slug, r.data.id);
    });
    identities = finaliseIdentities(set, appIds);
    appSlugsSharingId = set.appSlugsSharingId();

    const agentPulls = snap.merges.merged.flatMap((p) => {
      const login = p.user?.login;
      return typeof login === "string" && typeof p.number === "number" && matchLogin(identities, login) ? [p.number] : [];
    });
    const details = await Promise.all(agentPulls.map((n) => readPullDetail(client, snap, n)));
    agentPulls.forEach((n, i) => pullDetails.set(n, details[i] as PullDetail));

    const shas = new Map(snap.merges.merged.map((p) => [p.number, p.merge_commit_sha]));
    const plans = agentPulls.flatMap((number) => {
      const files = pullDetails.get(number)?.files;
      if (files?.state !== "read") return [];
      return [{ number, mergeSha: shas.get(number), changes: candidateChanges(files.data ?? [], changeGates) }];
    });
    mergeCandidates = await readCandidatesAtMerges(client, snap, plans);

    // An OrganizationAdmin bypass covers organisation owners only.
    const logins = orgMembershipLogins(snap, identities);
    const memberships = await Promise.all(logins.map((login) => readOrgMembership(client, parsed.owner, login)));
    logins.forEach((login, i) => orgMemberships.set(login.toLowerCase(), memberships[i] as ReadResult<OrgMembershipData>));

    // An agent app's installation permissions, where the token can read them.
    if (ownerType(snap) === "Organization" && identities.some((i) => i.kind === "app")) {
      orgInstallations = await readOrgInstallations(client, parsed.owner);
    }
  }

  const candidateGates =
    snap.candidates.state === "read" ? snap.candidates.results.filter((c) => c.state === "gate").map((c) => c.path) : [];
  const gates = gateSet(globs, codeownersPath, candidateGates);
  let rulesetRoles: RulesetRolesRead | undefined;
  let graphqlLog: ReadEntry[] = [];
  // The one exception to GET only is used only when check 4 can use its
  // answer: a role bypass, and an agent that holds a repository permission.
  if (o.graphqlRulesetRoles && snap.repositoryReadable && roleNamesCanMatter(snap, identities)) {
    const reader = new GraphQLReader({
      fetch: o.fetch,
      ...(o.apiUrl !== undefined ? { apiUrl: o.apiUrl } : {}),
      ...(o.token !== undefined ? { token: o.token } : {}),
      userAgent: `${TOOL_NAME}/${TOOL_VERSION}`,
    });
    rulesetRoles = await readRulesetRoles(reader, parsed.owner, parsed.name);
    graphqlLog = reader.log();
  }
  const checks = evaluate({
    snap,
    identities,
    gates,
    changeGates,
    pullDetails,
    mergeCandidates,
    appLookups,
    appIdConflicts,
    appSlugsSharingId,
    orgMemberships,
    ...(orgInstallations !== undefined ? { orgInstallations } : {}),
    ...(rulesetRoles !== undefined ? { rulesetRoles } : {}),
  });

  const c = snap.classic;
  const classicProtection: Assessment["classicProtection"] = !c
    ? { state: "not_read", basis: "not_read" }
    : c.state === "present"
      ? { state: "present", basis: "read" }
      : c.state === "absent"
        ? { state: "absent", basis: c.why }
        : { state: "unreadable", basis: "not_permitted_or_error" };

  const reads: ReadEntry[] = [...client.log().map((e) => ({ ...e, endpoint: `GET ${e.endpoint}` })), ...graphqlLog];
  return {
    repository: `${parsed.owner}/${parsed.name}`,
    apiUrl: client.apiUrl,
    repositoryReadable: snap.repositoryReadable,
    defaultBranch: snap.defaultBranch,
    commitSha: snap.commitSha,
    codeownersPath,
    settingsLocation: codeownersPath === ".github/CODEOWNERS" ? ".github/CODEOWNERS" : "README.md",
    classicProtection,
    readAt,
    reads,
    identities,
    checks,
  };
}
