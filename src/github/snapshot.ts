// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { Buffer } from "node:buffer";
import { CODEOWNERS_LOCATIONS } from "../codeowners.js";
import { DARZ_CONFIG_PATH, MAX_CANDIDATE_READS, holdsTestSettings, isCandidatePath } from "../gates.js";
import type { GitHubClient, ReadResult } from "./client.js";
import type {
  AppData,
  BranchData,
  ClassicProtectionData,
  CodeownersErrorData,
  CollaboratorData,
  ContentData,
  PullData,
  PullFileData,
  RepoData,
  ReviewData,
  Rule,
  RulesetData,
  TreeData,
} from "./types.js";

/** An agent app, by slug, with its app id when the declaration gives one. */
export interface AppDecl {
  slug: string;
  id?: number;
}

export interface DarzConfig {
  agents: string[];
  agentApps: AppDecl[];
  gates: string[];
}

/**
 * Parse an agent-app declaration from the command line: `slug` or `slug=id`.
 * Null when it is neither, so a typo never becomes a silent declaration.
 */
export function parseAppFlag(value: string): AppDecl | null {
  const m = /^([^=\s]+)(?:=([1-9][0-9]*))?$/.exec(value.trim());
  if (!m) return null;
  return m[2] === undefined ? { slug: m[1] as string } : { slug: m[1] as string, id: Number(m[2]) };
}

export type ConfigState =
  | { state: "absent"; endpoint: string }
  | { state: "valid"; endpoint: string; config: DarzConfig }
  | { state: "invalid"; endpoint: string; problem: string }
  | { state: "unreadable"; endpoint: string }
  | { state: "not_read" };

export type CodeownersState =
  | { state: "found"; path: string; text: string; endpoints: string[] }
  | { state: "none"; endpoints: string[] }
  | { state: "unreadable"; path: string; endpoints: string[] }
  | { state: "not_read"; endpoints: string[] };

export interface CandidateResult {
  path: string;
  state: "gate" | "not_gate" | "unreadable";
  endpoint: string;
  why?: string;
}

/** Files that are gate files only if they hold test or coverage settings (gates.ts). */
export type CandidateState =
  | { state: "not_read" }
  | { state: "over_cap"; count: number }
  | { state: "read"; results: CandidateResult[] };

export type ClassicState =
  | { state: "present"; data: ClassicProtectionData; endpoint: string }
  | { state: "absent"; endpoint: null; why: "branch_not_protected" }
  | { state: "absent"; endpoint: string; why: "admin_token_with_repo_scope" }
  | { state: "unreadable"; endpoint: string };

export interface Snapshot {
  owner: string;
  name: string;
  repoEndpoint: string;
  repo: ReadResult<RepoData>;
  repositoryReadable: boolean;
  defaultBranch: string | null;
  branch: ReadResult<BranchData> | null;
  commitSha: string | null;
  branchProtected: boolean | null;
  tree: ReadResult<TreeData> | null;
  config: ConfigState;
  codeowners: CodeownersState;
  codeownersErrors: ReadResult<{ errors?: CodeownersErrorData[] }> | null;
  rules: ReadResult<Rule[]> | null;
  classic: ClassicState | null;
  rulesets: Map<number, ReadResult<RulesetData>>;
  collaborators: ReadResult<CollaboratorData[]> | null;
  merges: { requested: number; pulls: ReadResult<PullData[]> | null; merged: PullData[] };
  candidates: CandidateState;
}

export const ep = (path: string) => `GET ${path}`;

function encodeRef(ref: string): string {
  return encodeURIComponent(ref).replace(/%2F/g, "/");
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function decodeContent(data: ContentData | null | undefined): string | null {
  if (!data || data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string") return null;
  return Buffer.from(data.content, "base64").toString("utf8");
}

export function parseConfig(text: string): DarzConfig | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "not valid JSON";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return "not a JSON object";
  const allowed = new Set(["agents", "agentApps", "gates"]);
  const out: DarzConfig = { agents: [], agentApps: [], gates: [] };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(k)) return `unknown key "${k}"`;
    if (!Array.isArray(v)) return `"${k}" must be an array`;
    if (k === "agentApps") {
      // Each entry is a slug, or { "slug": "...", "id": 123 } to name the app id
      // too, so no GET /apps/{slug} lookup is needed (issue 30).
      for (const x of v) {
        if (typeof x === "string" && x.length > 0) {
          out.agentApps.push({ slug: x });
          continue;
        }
        if (typeof x !== "object" || x === null || Array.isArray(x)) return '"agentApps" entries must be a slug or { "slug", "id" }';
        const keys = Object.keys(x);
        const o = x as Record<string, unknown>;
        if (keys.some((key) => key !== "slug" && key !== "id")) return '"agentApps" objects take only "slug" and "id"';
        if (typeof o.slug !== "string" || o.slug.length === 0) return '"agentApps" objects need a non-empty "slug"';
        if (o.id !== undefined && !(typeof o.id === "number" && Number.isInteger(o.id) && o.id > 0)) {
          return '"agentApps" "id" must be a positive whole number';
        }
        out.agentApps.push(o.id === undefined ? { slug: o.slug } : { slug: o.slug, id: o.id as number });
      }
      continue;
    }
    if (!v.every((x) => typeof x === "string" && x.length > 0)) return `"${k}" must be an array of non-empty strings`;
    out[k as "agents" | "gates"] = v as string[];
  }
  return out;
}

export interface ReadOptions {
  owner: string;
  name: string;
  merges: number;
}

/** Read everything the checks need, except what depends on agent identities. */
export async function readSnapshot(client: GitHubClient, o: ReadOptions): Promise<Snapshot> {
  const R = `/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.name)}`;
  const repo = await client.get<RepoData>(R, "content");
  const snap: Snapshot = {
    owner: o.owner,
    name: o.name,
    repoEndpoint: ep(R),
    repo,
    repositoryReadable: false,
    defaultBranch: null,
    branch: null,
    commitSha: null,
    branchProtected: null,
    tree: null,
    config: { state: "not_read" },
    codeowners: { state: "not_read", endpoints: [] },
    codeownersErrors: null,
    rules: null,
    classic: null,
    rulesets: new Map(),
    collaborators: null,
    merges: { requested: o.merges, pulls: null, merged: [] },
    candidates: { state: "not_read" },
  };
  const defaultBranch = repo.state === "read" ? repo.data?.default_branch : undefined;
  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) return snap;
  snap.repositoryReadable = true;
  snap.defaultBranch = defaultBranch;
  const B = encodeRef(defaultBranch);

  snap.branch = await client.get<BranchData>(`${R}/branches/${B}`, "content");
  if (snap.branch.state === "read") {
    const sha = snap.branch.data?.commit?.sha;
    if (typeof sha === "string" && /^[0-9a-f]{40,64}$/.test(sha)) snap.commitSha = sha;
    const prot = snap.branch.data?.protected;
    if (typeof prot === "boolean") snap.branchProtected = prot;
  }

  // Everything below depends only on the repository, the branch and its head,
  // so the reads run together; the client caps how many are in flight.
  const sha = snap.commitSha;
  await Promise.all([
    sha ? readTree(client, R, sha, snap) : null,
    sha ? readConfig(client, R, sha, snap) : null,
    sha ? readCodeowners(client, R, sha, snap) : null,
    readRules(client, R, B, snap),
    readClassic(client, R, B, snap),
    client
      .getAll<CollaboratorData>(`${R}/collaborators?affiliation=all&per_page=100`, "settings")
      .then((r) => {
        snap.collaborators = r;
      }),
    readMerges(client, R, defaultBranch, o.merges, snap),
  ]);
  return snap;
}

async function readTree(client: GitHubClient, R: string, sha: string, snap: Snapshot) {
  snap.tree = await client.get<TreeData>(`${R}/git/trees/${sha}?recursive=1`, "content");
  const t = snap.tree.state === "read" ? snap.tree.data : undefined;
  if (!t || t.truncated !== false || !Array.isArray(t.tree)) return;
  const found = t.tree.filter(
    (e) => e.type === "blob" && typeof e.path === "string" && typeof e.sha === "string" && isCandidatePath(e.path),
  ) as Array<{ path: string; sha: string }>;
  if (found.length > MAX_CANDIDATE_READS) {
    snap.candidates = { state: "over_cap", count: found.length };
    return;
  }
  const results = await Promise.all(
    found.map(async ({ path, sha: blob }): Promise<CandidateResult> => {
      const endpoint = `${R}/git/blobs/${blob}`;
      const r = await client.get<{ encoding?: string; content?: string }>(endpoint, "content");
      const text =
        r.state === "read" && r.data?.encoding === "base64" && typeof r.data.content === "string"
          ? Buffer.from(r.data.content, "base64").toString("utf8")
          : null;
      if (text === null) return { path, state: "unreadable", endpoint: ep(endpoint), why: "not read" };
      const holds = holdsTestSettings(path, text);
      if (holds === null) return { path, state: "unreadable", endpoint: ep(endpoint), why: "not parseable" };
      return { path, state: holds ? "gate" : "not_gate", endpoint: ep(endpoint) };
    }),
  );
  snap.candidates = { state: "read", results: results.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

async function readConfig(client: GitHubClient, R: string, sha: string, snap: Snapshot) {
  const cfgPath = `${R}/contents/${encodePath(DARZ_CONFIG_PATH)}?ref=${sha}`;
  const cfg = await client.get<ContentData>(cfgPath, "file");
  if (cfg.state !== "read") snap.config = { state: "unreadable", endpoint: ep(cfgPath) };
  else if (cfg.absent) snap.config = { state: "absent", endpoint: ep(cfgPath) };
  else {
    const text = decodeContent(cfg.data);
    if (text === null) snap.config = { state: "unreadable", endpoint: ep(cfgPath) };
    else {
      const parsed = parseConfig(text);
      snap.config =
        typeof parsed === "string"
          ? { state: "invalid", endpoint: ep(cfgPath), problem: parsed }
          : { state: "valid", endpoint: ep(cfgPath), config: parsed };
    }
  }
}

/** GitHub uses the first CODEOWNERS location that exists, so the locations are probed in order. */
async function readCodeowners(client: GitHubClient, R: string, sha: string, snap: Snapshot) {
  const endpoints: string[] = [];
  let co: CodeownersState = { state: "none", endpoints };
  for (const loc of CODEOWNERS_LOCATIONS) {
    const path = `${R}/contents/${encodePath(loc)}?ref=${sha}`;
    endpoints.push(ep(path));
    const r = await client.get<ContentData>(path, "file");
    if (r.state !== "read") {
      co = { state: "unreadable", path: loc, endpoints };
      break;
    }
    if (r.absent) continue;
    const text = decodeContent(r.data);
    co = text === null ? { state: "unreadable", path: loc, endpoints } : { state: "found", path: loc, text, endpoints };
    break;
  }
  snap.codeowners = co;
  if (co.state === "found") {
    snap.codeownersErrors = await client.get(`${R}/codeowners/errors?ref=${sha}`, "settings");
  }
}

async function readRules(client: GitHubClient, R: string, B: string, snap: Snapshot) {
  const rules = await client.getAll<Rule>(`${R}/rules/branches/${B}?per_page=100`, "settings");
  snap.rules = rules;
  if (rules.state !== "read") return;
  const ids = [
    ...new Set((rules.data ?? []).map((r) => r.ruleset_id).filter((x): x is number => typeof x === "number")),
  ].sort((a, b) => a - b);
  const results = await Promise.all(
    ids.map((id) => client.get<RulesetData>(`${R}/rulesets/${id}?includes_parents=true`, "settings")),
  );
  ids.forEach((id, i) => snap.rulesets.set(id, results[i] as ReadResult<RulesetData>));
}

async function readClassic(client: GitHubClient, R: string, B: string, snap: Snapshot) {
  if (snap.branchProtected === false) {
    snap.classic = { state: "absent", endpoint: null, why: "branch_not_protected" };
    return;
  }
  // A 404 here is what GitHub returns both for "no classic protection" and
  // for a token that may not read it. The user's role (permissions.admin) does
  // not say what the token may read. A classic token says what it may do in
  // x-oauth-scopes: with the repo scope and an admin user it can read classic
  // protection, so only then is a 404 proof that there is none (issue 18).
  // Fine-grained and app tokens send no scopes header, so a 404 stays unreadable.
  const protPath = `${R}/branches/${B}/protection`;
  const r = await client.get<ClassicProtectionData>(protPath, "settings");
  const canRead = snap.repo.data?.permissions?.admin === true && (snap.repo.oauthScopes ?? []).includes("repo");
  if (r.state === "read" && r.data && typeof r.data === "object") {
    snap.classic = { state: "present", data: r.data, endpoint: ep(protPath) };
  } else if (r.status === 404 && canRead) {
    snap.classic = { state: "absent", endpoint: ep(protPath), why: "admin_token_with_repo_scope" };
  } else {
    snap.classic = { state: "unreadable", endpoint: ep(protPath) };
  }
}

async function readMerges(client: GitHubClient, R: string, branch: string, merges: number, snap: Snapshot) {
  const pullsPath = `${R}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=100`;
  const pulls = await client.getAll<PullData>(
    pullsPath,
    "content",
    (items) => items.filter((p) => typeof p.merged_at === "string").length >= merges,
  );
  snap.merges.pulls = pulls;
  if (pulls.state === "read") {
    snap.merges.merged = (pulls.data ?? [])
      .filter((p) => typeof p.merged_at === "string" && typeof p.number === "number")
      .sort((a, b) => String(b.merged_at).localeCompare(String(a.merged_at)) || (b.number ?? 0) - (a.number ?? 0))
      .slice(0, merges);
  }
}

/**
 * The errors GitHub reports for the CODEOWNERS file in use, or null when there is
 * no such file or `codeowners/errors` was not read.
 */
export function codeownersErrorsInUse(snap: Snapshot): CodeownersErrorData[] | null {
  const co = snap.codeowners;
  if (co.state !== "found") return null;
  const list = snap.codeownersErrors?.state === "read" ? snap.codeownersErrors.data?.errors : undefined;
  if (!Array.isArray(list)) return null;
  return list.filter((e) => e.path === undefined || e.path === co.path);
}

/** The reported errors with a line number, as `parseCodeowners` takes them. */
export function errorLines(errors: readonly CodeownersErrorData[]): Array<{ line: number; column?: number; kind?: string }> {
  return errors.flatMap((e) =>
    typeof e.line === "number"
      ? [
          {
            line: e.line,
            ...(typeof e.column === "number" ? { column: e.column } : {}),
            ...(typeof e.kind === "string" ? { kind: e.kind } : {}),
          },
        ]
      : [],
  );
}

export interface PullDetail {
  files: ReadResult<PullFileData[]>;
  reviews: ReadResult<ReviewData[]>;
}

export async function readPullDetail(client: GitHubClient, snap: Snapshot, number: number): Promise<PullDetail> {
  const R = `/repos/${encodeURIComponent(snap.owner)}/${encodeURIComponent(snap.name)}`;
  const [files, reviews] = await Promise.all([
    client.getAll<PullFileData>(`${R}/pulls/${number}/files?per_page=100`, "content"),
    client.getAll<ReviewData>(`${R}/pulls/${number}/reviews?per_page=100`, "content"),
  ]);
  return { files, reviews };
}

export async function readApp(client: GitHubClient, slug: string): Promise<ReadResult<AppData>> {
  return client.get<AppData>(`/apps/${encodeURIComponent(slug)}`, "content");
}
