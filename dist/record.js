// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { exitCodeFor } from "./exit.js";
import { RECORD_FORMAT, TOOL_NAME, TOOL_VERSION } from "./version.js";
export function buildRecord(a, options) {
    const count = (s) => a.checks.filter((c) => c.status === s).length;
    const reads = [...a.reads].sort((x, y) => (x.endpoint < y.endpoint ? -1 : x.endpoint > y.endpoint ? 1 : 0));
    return {
        format: RECORD_FORMAT,
        tool: { name: TOOL_NAME, version: TOOL_VERSION },
        repository: a.repository,
        apiUrl: a.apiUrl,
        defaultBranch: a.defaultBranch,
        commitSha: a.commitSha,
        ref: a.ref,
        readAt: a.readAt,
        options: {
            agents: [...options.agents],
            agentApps: [...options.agentApps],
            gates: [...options.gates],
            merges: options.merges,
            graphqlRulesetRoles: options.graphqlRulesetRoles === true,
            ref: options.ref ?? null,
        },
        classicProtection: a.classicProtection,
        reads,
        agentIdentities: a.identities,
        checks: a.checks,
        summary: { pass: count("pass"), fail: count("fail"), unverifiable: count("unverifiable"), context: count("context") },
        exitCode: exitCodeFor(a.repositoryReadable, a.checks),
    };
}
/** The record's exact bytes (RFC 8785 canonical JSON, UTF-8) and their SHA-256. */
export function serializeRecord(record) {
    const bytes = Buffer.from(canonicalize(record), "utf8");
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
