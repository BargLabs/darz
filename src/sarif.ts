// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import type { Assessment } from "./assess.js";
import { CHECK_IDS, CHECK_TITLES, type CheckId, type CheckRow } from "./checks/types.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

const INFO_URI = "https://github.com/BargLabs/darz";

const HELP: Record<CheckId, string> = {
  gate_files_owned:
    "Every gate file (CI workflows and actions, the CODEOWNERS file in use, test and coverage configuration, package.json, vite.config.*, pyproject.toml or setup.cfg when they hold test settings, .github/darz.json) must have a code owner, as must a new file in a gate directory and a CODEOWNERS file in a location GitHub reads first; and the default branch must require code-owner review. Otherwise an agent can change the rules that judge it with an ordinary approval. Unverifiable when the tree, CODEOWNERS, codeowners/errors, a candidate file or the rules could not be read, or the tree was truncated.",
  human_review_required:
    "The default branch must require at least one approving review, dismiss stale approvals on push, and require approval of the most recent push by someone other than its pusher, from the effective rules or classic protection. Unverifiable when a source that could supply a missing setting could not be read; classic protection needs a token with repository administration read.",
  writer_not_approver:
    "Approval of the most recent push must come from someone other than its pusher, and no agent identity may be a code owner of a gate file. Unverifiable with no agent identities.",
  agents_cannot_bypass:
    "No agent identity may be a ruleset bypass actor, be covered by a role-based bypass, hold admin permission, or be allowed to bypass classic pull request requirements. Unverifiable when a ruleset, its bypass list, the collaborators list or classic protection could not be read, or with no agent identities.",
  required_checks_fail_closed:
    "At least one status check must be required before merging, by a rule or by classic protection, and every required check must be pinned to the app that must report it, none to an agent app. An unpinned check can be satisfied by anyone who can post a status or check run with that name. Unverifiable when a source that could pin or require a check could not be read.",
  agent_merges_touching_gates:
    "Context only: the last N merged pull requests by agent identities, the gate files each changed and who approved it. Unverifiable when a list it needs could not be read, or with no agent identities.",
};

function pascal(id: string): string {
  return id
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function messageFor(row: CheckRow): string {
  const parts = row.reasons.map((r) => `${r.code}: ${r.message}${r.subjects ? ` (${r.subjects.join("; ")})` : ""}`);
  return `${row.title}: ${row.status}. ${parts.join(" ")}`.trim();
}

/**
 * The web URL of the GitHub instance behind an API URL, or null when it cannot be
 * told: github.com, GitHub Enterprise Server (`https://host/api/v3`) and GHE.com
 * (`https://api.SUBDOMAIN.ghe.com`).
 */
export function webUrlFor(apiUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(apiUrl);
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, "");
  if (u.hostname === "api.github.com" && path === "") return "https://github.com";
  if (/^api\.[a-z0-9-]+\.ghe\.com$/i.test(u.hostname) && path === "") return `${u.protocol}//${u.host.slice(4)}`;
  if (path === "/api/v3") return u.origin;
  return null;
}

function locationFor(a: Assessment, row: CheckRow): string {
  const fileRow = row.id === "gate_files_owned" || row.id === "writer_not_approver";
  if (fileRow && a.codeownersPath) return a.codeownersPath;
  return a.settingsLocation;
}

export function buildSarif(a: Assessment): Record<string, unknown> {
  const rules = CHECK_IDS.map((id) => ({
    id: `darz/${id}`,
    name: pascal(id),
    shortDescription: { text: CHECK_TITLES[id] },
    fullDescription: { text: HELP[id] },
    help: { text: HELP[id] },
    helpUri: `${INFO_URI}/blob/main/docs/checks.md#${CHECK_IDS.indexOf(id) + 1}-${id}`,
    defaultConfiguration: { level: id === "agent_merges_touching_gates" ? "warning" : "error" },
  }));
  const results = a.checks
    .filter((c) => c.status === "fail" || c.status === "unverifiable")
    .map((c) => ({
      ruleId: `darz/${c.id}`,
      ruleIndex: CHECK_IDS.indexOf(c.id),
      level: c.status === "fail" ? "error" : "warning",
      message: { text: messageFor(c) },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: locationFor(a, c) },
            region: { startLine: 1 },
          },
        },
      ],
      properties: { status: c.status, reasons: c.reasons.map((r) => r.code) },
    }));
  const run: Record<string, unknown> = {
    tool: { driver: { name: TOOL_NAME, version: TOOL_VERSION, semanticVersion: TOOL_VERSION, informationUri: INFO_URI, rules } },
    results,
    properties: { repository: a.repository, readAt: a.readAt },
  };
  const web = webUrlFor(a.apiUrl);
  if (a.commitSha && a.defaultBranch && web) {
    run.versionControlProvenance = [
      { repositoryUri: `${web}/${a.repository}`, revisionId: a.commitSha, branch: a.defaultBranch },
    ];
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [run],
  };
}
