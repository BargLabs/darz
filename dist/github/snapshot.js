// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { Buffer } from "node:buffer";
import { CODEOWNERS_LOCATIONS } from "../codeowners.js";
import { DARZ_CONFIG_PATH, MAX_CANDIDATE_READS, MAX_MERGE_CANDIDATE_READS, holdsTestSettings, isCandidatePath, isGatePathForChange, } from "../gates.js";
/**
 * Parse an agent-app declaration from the command line: `slug` or `slug=id`.
 * Null when it is neither, so a typo never becomes a silent declaration.
 */
export function parseAppFlag(value) {
    const m = /^([^=\s]+)(?:=([1-9][0-9]*))?$/.exec(value.trim());
    if (!m)
        return null;
    return m[2] === undefined ? { slug: m[1] } : { slug: m[1], id: Number(m[2]) };
}
export const ep = (path) => `GET ${path}`;
function encodeRef(ref) {
    return encodeURIComponent(ref).replace(/%2F/g, "/");
}
function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}
export function decodeContent(data) {
    if (!data || data.type !== "file" || data.encoding !== "base64" || typeof data.content !== "string")
        return null;
    return Buffer.from(data.content, "base64").toString("utf8");
}
export function parseConfig(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return "not valid JSON";
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return "not a JSON object";
    const allowed = new Set(["agents", "agentApps", "gates"]);
    const out = { agents: [], agentApps: [], gates: [] };
    for (const [k, v] of Object.entries(raw)) {
        if (!allowed.has(k))
            return `unknown key "${k}"`;
        if (!Array.isArray(v))
            return `"${k}" must be an array`;
        if (k === "agentApps") {
            // Each entry is a slug, or { "slug": "...", "id": 123 } to name the app id
            // too, so no GET /apps/{slug} lookup is needed.
            for (const x of v) {
                if (typeof x === "string" && x.length > 0) {
                    out.agentApps.push({ slug: x });
                    continue;
                }
                if (typeof x !== "object" || x === null || Array.isArray(x))
                    return '"agentApps" entries must be a slug or { "slug", "id" }';
                const keys = Object.keys(x);
                const o = x;
                if (keys.some((key) => key !== "slug" && key !== "id"))
                    return '"agentApps" objects take only "slug" and "id"';
                if (typeof o.slug !== "string" || o.slug.length === 0)
                    return '"agentApps" objects need a non-empty "slug"';
                if (o.id !== undefined && !(typeof o.id === "number" && Number.isInteger(o.id) && o.id > 0)) {
                    return '"agentApps" "id" must be a positive whole number';
                }
                out.agentApps.push(o.id === undefined ? { slug: o.slug } : { slug: o.slug, id: o.id });
            }
            continue;
        }
        if (!v.every((x) => typeof x === "string" && x.length > 0))
            return `"${k}" must be an array of non-empty strings`;
        out[k] = v;
    }
    return out;
}
/** Read everything the checks need, except what depends on agent identities. */
export async function readSnapshot(client, o) {
    const R = `/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.name)}`;
    const repo = await client.get(R, "content");
    const snap = {
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
        merges: { requested: o.merges, pulls: null, merged: [], pageCap: mergePageCap(o.merges) },
        candidates: { state: "not_read" },
    };
    const defaultBranch = repo.state === "read" ? repo.data?.default_branch : undefined;
    if (typeof defaultBranch !== "string" || defaultBranch.length === 0)
        return snap;
    snap.repositoryReadable = true;
    snap.defaultBranch = defaultBranch;
    const B = encodeRef(defaultBranch);
    snap.branch = await client.get(`${R}/branches/${B}`, "content");
    if (snap.branch.state === "read") {
        const sha = snap.branch.data?.commit?.sha;
        if (typeof sha === "string" && /^[0-9a-f]{40,64}$/.test(sha))
            snap.commitSha = sha;
        const prot = snap.branch.data?.protected;
        if (typeof prot === "boolean")
            snap.branchProtected = prot;
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
            .getAll(`${R}/collaborators?affiliation=all&per_page=100`, "settings")
            .then((r) => {
            snap.collaborators = r;
        }),
        readMerges(client, R, defaultBranch, o.merges, snap),
    ]);
    // A protected branch is protected by rules or by classic protection. If the
    // effective rules were read and there are none, classic protection must
    // exist, so a 404 on it is not proof of absence: the answers contradict
    // each other, and the classic state is unknown.
    if (snap.classic?.state === "absent" &&
        snap.classic.why === "admin_token_with_repo_scope" &&
        snap.rules?.state === "read" &&
        (snap.rules.data ?? []).length === 0) {
        snap.classic = { state: "unreadable", endpoint: snap.classic.endpoint };
    }
    return snap;
}
async function readTree(client, R, sha, snap) {
    snap.tree = await client.get(`${R}/git/trees/${sha}?recursive=1`, "content");
    const t = snap.tree.state === "read" ? snap.tree.data : undefined;
    if (!t || t.truncated !== false || !Array.isArray(t.tree))
        return;
    const found = t.tree.filter((e) => e.type === "blob" && typeof e.path === "string" && typeof e.sha === "string" && isCandidatePath(e.path));
    // Files with the same blob have the same content, so each blob is read
    // once; each path is still judged by its own name.
    const blobs = new Set(found.map((f) => f.sha));
    if (blobs.size > MAX_CANDIDATE_READS) {
        snap.candidates = { state: "over_cap", count: found.length, distinct: blobs.size };
        return;
    }
    const texts = new Map();
    const readBlob = (blob) => {
        let p = texts.get(blob);
        if (!p) {
            const endpoint = `${R}/git/blobs/${blob}`;
            p = client.get(endpoint, "content").then((r) => ({
                endpoint,
                text: r.state === "read" && r.data?.encoding === "base64" && typeof r.data.content === "string"
                    ? Buffer.from(r.data.content, "base64").toString("utf8")
                    : null,
            }));
            texts.set(blob, p);
        }
        return p;
    };
    const results = await Promise.all(found.map(async ({ path, sha: blob }) => {
        const { endpoint, text } = await readBlob(blob);
        if (text === null)
            return { path, state: "unreadable", endpoint: ep(endpoint), why: "not read" };
        const holds = holdsTestSettings(path, text);
        if (holds === null)
            return { path, state: "unreadable", endpoint: ep(endpoint), why: "not parseable" };
        return { path, state: holds ? "gate" : "not_gate", endpoint: ep(endpoint) };
    }));
    snap.candidates = { state: "read", results: results.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}
async function readConfig(client, R, sha, snap) {
    const cfgPath = `${R}/contents/${encodePath(DARZ_CONFIG_PATH)}?ref=${sha}`;
    const cfg = await client.get(cfgPath, "file");
    if (cfg.state !== "read")
        snap.config = { state: "unreadable", endpoint: ep(cfgPath) };
    else if (cfg.absent)
        snap.config = { state: "absent", endpoint: ep(cfgPath) };
    else {
        const text = decodeContent(cfg.data);
        if (text === null)
            snap.config = { state: "unreadable", endpoint: ep(cfgPath) };
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
async function readCodeowners(client, R, sha, snap) {
    const endpoints = [];
    let co = { state: "none", endpoints };
    for (const loc of CODEOWNERS_LOCATIONS) {
        const path = `${R}/contents/${encodePath(loc)}?ref=${sha}`;
        endpoints.push(ep(path));
        const r = await client.get(path, "file");
        if (r.state !== "read") {
            co = { state: "unreadable", path: loc, endpoints };
            break;
        }
        if (r.absent)
            continue;
        const text = decodeContent(r.data);
        co = text === null ? { state: "unreadable", path: loc, endpoints } : { state: "found", path: loc, text, endpoints };
        break;
    }
    snap.codeowners = co;
    if (co.state === "found") {
        snap.codeownersErrors = await client.get(`${R}/codeowners/errors?ref=${sha}`, "settings");
    }
}
async function readRules(client, R, B, snap) {
    const rules = await client.getAll(`${R}/rules/branches/${B}?per_page=100`, "settings");
    snap.rules = rules;
    if (rules.state !== "read")
        return;
    const ids = [
        ...new Set((rules.data ?? []).map((r) => r.ruleset_id).filter((x) => typeof x === "number")),
    ].sort((a, b) => a - b);
    const results = await Promise.all(ids.map((id) => client.get(`${R}/rulesets/${id}?includes_parents=true`, "settings")));
    ids.forEach((id, i) => snap.rulesets.set(id, results[i]));
}
async function readClassic(client, R, B, snap) {
    if (snap.branchProtected === false) {
        snap.classic = { state: "absent", endpoint: null, why: "branch_not_protected" };
        return;
    }
    // A 404 here is what GitHub returns both for "no classic protection" and
    // for a token that may not read it. The user's role (permissions.admin) does
    // not say what the token may read. A classic token says what it may do in
    // x-oauth-scopes: with the repo scope and an admin user it can read classic
    // protection, so only then is a 404 proof that there is none.
    // Fine-grained and app tokens send no scopes header, so a 404 stays unreadable.
    // The branch must also have been read as protected: GitHub answers 404 here
    // for a branch it cannot find too, so without the branch read a 404 proves
    // nothing.
    const protPath = `${R}/branches/${B}/protection`;
    const r = await client.get(protPath, "settings");
    const canRead = snap.branchProtected === true &&
        snap.repo.data?.permissions?.admin === true &&
        (snap.repo.oauthScopes ?? []).includes("repo");
    if (r.state === "read" && r.data && typeof r.data === "object") {
        snap.classic = { state: "present", data: r.data, endpoint: ep(protPath) };
    }
    else if (r.status === 404 && canRead) {
        snap.classic = { state: "absent", endpoint: ep(protPath), why: "admin_token_with_repo_scope" };
    }
    else {
        snap.classic = { state: "unreadable", endpoint: ep(protPath) };
    }
}
/**
 * Pages of closed pull requests Darz reads past the fewest that could hold N
 * merges (N / 100, rounded up). Each page is one request of 100 closed pull
 * requests; ten more allow for 1,000 closed pull requests that were not merged
 * or were merged earlier and updated since.
 */
export const MERGE_EXTRA_PAGES = 10;
export function mergePageCap(merges) {
    return Math.ceil(merges / 100) + MERGE_EXTRA_PAGES;
}
const time = (s) => {
    if (typeof s !== "string")
        return null;
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
};
/**
 * Whether the pull requests read so far, newest update first, settle the N most
 * recently merged. Merging sets `updated_at`, so a pull request not yet read was
 * updated, and so merged, no later than the oldest update read. Once that is
 * older than the Nth merge read, no unread pull request can be among the last N.
 */
export function mergesSettled(items, merges) {
    const merged = items
        .map((p) => time(p.merged_at))
        .filter((t) => t !== null)
        .sort((a, b) => b - a);
    const nth = merged[merges - 1];
    if (nth === undefined)
        return false;
    const updated = items.map((p) => time(p.updated_at)).filter((t) => t !== null);
    if (updated.length === 0)
        return false;
    return Math.min(...updated) < nth;
}
async function readMerges(client, R, branch, merges, snap) {
    const pullsPath = `${R}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=100`;
    const pulls = await client.getAll(pullsPath, "content", (items) => mergesSettled(items, merges), snap.merges.pageCap);
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
export function codeownersErrorsInUse(snap) {
    const co = snap.codeowners;
    if (co.state !== "found")
        return null;
    const list = snap.codeownersErrors?.state === "read" ? snap.codeownersErrors.data?.errors : undefined;
    if (!Array.isArray(list))
        return null;
    return list.filter((e) => e.path === undefined || e.path === co.path);
}
/** The reported errors with a line number, as `parseCodeowners` takes them. */
export function errorLines(errors) {
    return errors.flatMap((e) => typeof e.line === "number"
        ? [
            {
                line: e.line,
                ...(typeof e.column === "number" ? { column: e.column } : {}),
                ...(typeof e.kind === "string" ? { kind: e.kind } : {}),
            },
        ]
        : []);
}
export async function readPullDetail(client, snap, number) {
    const R = `/repos/${encodeURIComponent(snap.owner)}/${encodeURIComponent(snap.name)}`;
    const [files, reviews] = await Promise.all([
        client.getAll(`${R}/pulls/${number}/files?per_page=100`, "content"),
        client.getAll(`${R}/pulls/${number}/reviews?per_page=100`, "content"),
    ]);
    return { files, reviews };
}
export async function readApp(client, slug) {
    return client.get(`/apps/${encodeURIComponent(slug)}`, "content");
}
const HEX_SHA = /^[0-9a-f]{40,64}$/;
/**
 * The changed paths check 6 can judge only by reading them: candidate paths
 * that no gate pattern or exact gate path already covers. `gates` must not
 * hold candidates judged at the head.
 */
export function candidateChanges(files, gates) {
    const out = new Map();
    const needsRead = (p) => typeof p === "string" && !out.has(p) && isCandidatePath(p) && !isGatePathForChange(gates, p);
    for (const f of files) {
        const path = f.filename;
        if (needsRead(path)) {
            if (f.status !== "removed")
                out.set(path, { path, at: "merge" });
            else if (typeof f.sha === "string" && HEX_SHA.test(f.sha))
                out.set(path, { path, at: "blob", blob: f.sha });
            else
                out.set(path, { path, at: "parent" });
        }
        if (needsRead(f.previous_filename))
            out.set(f.previous_filename, { path: f.previous_filename, at: "parent" });
    }
    return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}
/**
 * Read each agent pull request's changed candidate files as they were at its
 * merge, within {@link MAX_MERGE_CANDIDATE_READS}. `plans` come newest merge
 * first; once a pull request's reads would pass the cap, it and every later
 * one is `over_cap` and nothing is read for them.
 */
export async function readCandidatesAtMerges(client, snap, plans) {
    const R = `/repos/${encodeURIComponent(snap.owner)}/${encodeURIComponent(snap.name)}`;
    const out = new Map();
    let budget = MAX_MERGE_CANDIDATE_READS;
    let exhausted = false;
    const reads = [];
    for (const plan of plans) {
        if (plan.changes.length === 0)
            continue;
        const sha = typeof plan.mergeSha === "string" && HEX_SHA.test(plan.mergeSha) ? plan.mergeSha : null;
        const readable = plan.changes.filter((c) => c.at === "blob" || sha !== null);
        const cost = readable.length + (sha !== null && readable.some((c) => c.at === "parent") ? 1 : 0);
        if (exhausted || cost > budget) {
            exhausted = true;
            out.set(plan.number, { state: "over_cap" });
            continue;
        }
        budget -= cost;
        reads.push(readOnePlan(client, R, plan.changes, sha).then((r) => {
            out.set(plan.number, r);
        }));
    }
    await Promise.all(reads);
    return out;
}
async function readOnePlan(client, R, changes, sha) {
    const endpoints = [];
    let parent = null;
    const parentSha = (mergeSha) => {
        if (!parent) {
            const path = `${R}/git/commits/${mergeSha}`;
            endpoints.push(ep(path));
            parent = client.get(path, "content").then((r) => {
                const p = r.state === "read" ? r.data?.parents?.[0]?.sha : undefined;
                return typeof p === "string" && HEX_SHA.test(p) ? p : null;
            });
        }
        return parent;
    };
    const judge = (path, text, why) => {
        if (text === null)
            return { path, state: "unreadable", why };
        const holds = holdsTestSettings(path, text);
        if (holds === null)
            return { path, state: "unreadable", why: "not parseable" };
        return { path, state: holds ? "gate" : "not_gate" };
    };
    const atRef = async (path, ref, missing) => {
        const endpoint = `${R}/contents/${encodePath(path)}?ref=${ref}`;
        endpoints.push(ep(endpoint));
        const r = await client.get(endpoint, "file");
        if (r.state === "read" && r.absent)
            return { path, state: "unreadable", why: missing };
        return judge(path, r.state === "read" ? decodeContent(r.data) : null, "not read");
    };
    const results = await Promise.all(changes.map(async (c) => {
        if (c.at === "blob" && c.blob) {
            const endpoint = `${R}/git/blobs/${c.blob}`;
            endpoints.push(ep(endpoint));
            const r = await client.get(endpoint, "content");
            const text = r.state === "read" && r.data?.encoding === "base64" && typeof r.data.content === "string"
                ? Buffer.from(r.data.content, "base64").toString("utf8")
                : null;
            return judge(c.path, text, "not read");
        }
        if (sha === null)
            return { path: c.path, state: "unreadable", why: "no merge commit SHA" };
        if (c.at === "merge")
            return atRef(c.path, sha, "not found at the merge commit");
        const p = await parentSha(sha);
        if (p === null)
            return { path: c.path, state: "unreadable", why: "merge commit's parent not read" };
        return atRef(c.path, p, "not found before the merge");
    }));
    return { state: "read", results, endpoints: endpoints.sort() };
}
/**
 * A user's membership of the organisation that owns the repository, for an
 * OrganizationAdmin bypass. GitHub answers 404 both for a user who
 * is not a member and for a membership the token cannot see, so a 404 is
 * `not_permitted`, never proof that the user is not an owner.
 */
export async function readOrgMembership(client, org, login) {
    return client.get(`/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`, "settings");
}
/** The repository owner's account type, or null when the response does not say. */
export function ownerType(snap) {
    const t = snap.repo.state === "read" ? snap.repo.data?.owner?.type : undefined;
    return t === "Organization" || t === "User" ? t : null;
}
/**
 * Every GitHub App installation on the organisation, with each one's app id,
 * slug and permissions. GitHub serves it to an organisation owner,
 * or a token with organisation Administration: read; the GitHub Actions
 * workflow token cannot read it. A 404 is `not_permitted`.
 */
export async function readOrgInstallations(client, org) {
    return client.getAll(`/orgs/${encodeURIComponent(org)}/installations?per_page=100`, "settings", undefined, undefined, "installations");
}
