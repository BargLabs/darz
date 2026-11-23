// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { createHash } from "node:crypto";
import type { Assessment, ReadEntry } from "./assess.js";
import { canonicalize } from "./canonical.js";
import type { CheckRow } from "./checks/types.js";
import { exitCodeFor } from "./exit.js";
import type { AgentIdentity } from "./identities.js";
import { RECORD_FORMAT, TOOL_NAME, TOOL_VERSION } from "./version.js";

export interface RecordOptions {
  agents: string[];
  agentApps: string[];
  gates: string[];
  merges: number;
}

export interface DarzRecord {
  format: typeof RECORD_FORMAT;
  tool: { name: string; version: string };
  repository: string;
  apiUrl: string;
  defaultBranch: string | null;
  commitSha: string | null;
  readAt: string;
  options: RecordOptions;
  classicProtection: Assessment["classicProtection"];
  reads: ReadEntry[];
  agentIdentities: AgentIdentity[];
  checks: CheckRow[];
  summary: { pass: number; fail: number; unverifiable: number; context: number };
  exitCode: 0 | 1 | 2 | 3;
}

export function buildRecord(a: Assessment, options: RecordOptions): DarzRecord {
  const count = (s: CheckRow["status"]) => a.checks.filter((c) => c.status === s).length;
  const reads = [...a.reads].sort((x, y) => (x.endpoint < y.endpoint ? -1 : x.endpoint > y.endpoint ? 1 : 0));
  return {
    format: RECORD_FORMAT,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    repository: a.repository,
    apiUrl: a.apiUrl,
    defaultBranch: a.defaultBranch,
    commitSha: a.commitSha,
    readAt: a.readAt,
    options: {
      agents: [...options.agents],
      agentApps: [...options.agentApps],
      gates: [...options.gates],
      merges: options.merges,
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
export function serializeRecord(record: DarzRecord): { bytes: Buffer; sha256: string } {
  const bytes = Buffer.from(canonicalize(record), "utf8");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
