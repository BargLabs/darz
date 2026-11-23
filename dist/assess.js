// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { evaluate } from "./checks/evaluate.js";
import { GitHubClient } from "./github/client.js";
import { readApp, readPullDetail, readSnapshot } from "./github/snapshot.js";
import { gateSet } from "./gates.js";
import { collectIdentities, finaliseIdentities, matchLogin } from "./identities.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";
export const DEFAULT_MERGES = 50;
export function parseRepo(repo) {
    const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(repo);
    if (!m || m[2] === "." || m[2] === "..")
        return null;
    return { owner: m[1], name: m[2] };
}
export async function assess(o) {
    const parsed = parseRepo(o.repo);
    if (!parsed)
        throw new Error(`not an owner/name repository: ${o.repo}`);
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
    let identities = [];
    const pullDetails = new Map();
    const appLookups = new Map();
    if (snap.repositoryReadable) {
        const set = collectIdentities(snap, flags);
        const slugs = [
            ...new Set(set.list().flatMap((id) => (id.kind === "app" && id.slug !== undefined ? [id.slug.toLowerCase()] : []))),
        ];
        const apps = await Promise.all(slugs.map((slug) => readApp(client, slug)));
        const appIds = new Map();
        slugs.forEach((slug, i) => {
            const r = apps[i];
            appLookups.set(slug, r);
            if (r.state === "read" && typeof r.data?.id === "number")
                appIds.set(slug, r.data.id);
        });
        identities = finaliseIdentities(set, appIds);
        const agentPulls = snap.merges.merged.flatMap((p) => {
            const login = p.user?.login;
            return typeof login === "string" && typeof p.number === "number" && matchLogin(identities, login) ? [p.number] : [];
        });
        const details = await Promise.all(agentPulls.map((n) => readPullDetail(client, snap, n)));
        agentPulls.forEach((n, i) => pullDetails.set(n, details[i]));
    }
    const configGates = snap.config.state === "valid" ? snap.config.config.gates : [];
    const codeownersPath = snap.codeowners.state === "found" ? snap.codeowners.path : null;
    const candidateGates = snap.candidates.state === "read" ? snap.candidates.results.filter((c) => c.state === "gate").map((c) => c.path) : [];
    const gates = gateSet([...(o.gates ?? []), ...configGates], codeownersPath, candidateGates);
    const checks = evaluate({ snap, identities, gates, pullDetails, appLookups });
    const c = snap.classic;
    const classicProtection = !c
        ? { state: "not_read", basis: "not_read" }
        : c.state === "present"
            ? { state: "present", basis: "read" }
            : c.state === "absent"
                ? { state: "absent", basis: c.why }
                : { state: "unreadable", basis: "not_permitted_or_error" };
    const reads = client.log().map((e) => ({ ...e, endpoint: `GET ${e.endpoint}` }));
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
