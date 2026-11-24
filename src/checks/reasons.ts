// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import type { Reason } from "./types.js";

/** Every reason code a row can carry, with its message. docs/checks.md mirrors this table. */
export const REASONS: Record<string, string> = {
  repository_unreadable: "The repository itself could not be read.",
  no_agent_identities: "No agent identity was declared or detected, so there is nothing to check against.",
  config_invalid: ".github/darz.json exists but is not valid; declared agents and gates are unknown.",
  config_unreadable: ".github/darz.json could not be read; declared agents and gates are unknown.",
  field_missing: "A field the check needs is missing from a response that was read.",
  rules_unreadable: "The branch's effective rules (GET /repos/{owner}/{repo}/rules/branches/{branch}) could not be read.",
  classic_protection_unreadable:
    "The branch is protected but classic branch protection could not be read; reading it needs repository administration access.",

  tree_unreadable: "The repository tree at the default branch's head could not be read.",
  tree_truncated: "GitHub truncated the tree response, so the gate-file inventory is incomplete.",
  codeowners_unreadable: "A CODEOWNERS file could not be read, so which file GitHub uses is unknown.",
  codeowners_errors_unreadable: "GET /repos/{owner}/{repo}/codeowners/errors could not be read, so which lines GitHub ignores is unknown.",
  codeowners_error_ambiguous:
    "The last CODEOWNERS line matching these gate files has an error whose handling is not verified (an unknown kind, or an error with no column at an owner): applied with its unflagged owners, or ignored for an earlier line, it could give them an owner.",
  gate_candidate_unreadable:
    "A package.json, vite.config.*, pyproject.toml or setup.cfg could not be read or parsed, so whether it holds test settings, and is a gate file, is unknown.",
  gate_candidates_over_cap:
    "The tree has more distinct candidate files (package.json, vite.config.*, pyproject.toml, setup.cfg) than the 500 Darz reads, so the gate-file inventory is incomplete.",
  gate_files_unowned: "These gate files have no code owner.",
  new_gate_paths_unowned:
    "These paths are not in the tree but would change the gate if added, and have no code owner: a CODEOWNERS location GitHub reads before the file in use, or a new file in a gate directory.",
  no_codeowners_file: "No CODEOWNERS file exists in any location GitHub reads.",
  code_owner_review_not_required: "The default branch does not require code-owner review.",

  no_pull_request_rule: "No rule or classic protection requires a pull request on the default branch.",
  approving_review_not_required: "At least one approving review is not required.",
  stale_reviews_not_dismissed: "Stale approvals are not dismissed when new commits are pushed.",
  last_push_approval_not_required: "Approval of the most recent push by someone other than its pusher is not required.",

  agent_is_code_owner: "An agent identity is a code owner of gate files, so it can satisfy code-owner review of them.",
  unresolved_owners:
    "Gate files are owned by teams or email addresses whose members Darz does not read, and a declared user agent could be one of them.",

  agent_app_can_bypass: "A ruleset lets an agent app bypass it.",
  agent_app_can_administer:
    "An agent app's installation has administration: write or organization_administration: write, so it can change or delete the rulesets and branch protection that bind it.",
  agent_role_can_bypass: "A ruleset's role-based bypass covers an agent identity's permission.",
  agent_is_admin: "An agent identity has admin permission on the repository.",
  admins_not_enforced_agent_is_admin: "Classic protection does not apply to admins, and an agent identity is an admin.",
  agent_in_bypass_allowance: "Classic protection lets an agent identity bypass pull request requirements.",
  ruleset_unreadable: "A ruleset in effect on the default branch could not be read.",
  bypass_list_unreadable: "A ruleset response does not include bypass_actors; reading it needs write access to the ruleset.",
  bypass_role_unknown:
    "A ruleset bypass names a repository role by id, GitHub does not document which role an id is, and an agent identity holds a repository permission that the role might cover.",
  bypass_role_inheritance_unknown:
    "A ruleset's repository-role bypass names a role below an agent identity's role; GitHub does not document whether a role's bypass covers higher roles.",
  bypass_role_order_unknown:
    "A ruleset's repository-role bypass names a role that is not an agent identity's role, and one of the two is a custom role; Darz does not read where a custom role stands among the built-in roles.",
  bypass_actor_unknown: "A ruleset bypass names an actor type Darz does not know.",
  team_bypass_members_unread: "A team can bypass, its members were not read, and a declared user agent could be a member.",
  agent_app_unresolved:
    "A declared agent app's slug could not be resolved with GET /apps/{slug}: it may be misspelt, or the read failed, so checks about it may be about no app at all.",
  collaborators_unreadable: "The collaborators list could not be read, so agent permissions are unknown.",

  no_required_checks: "No status check is required before merging.",
  required_check_unpinned:
    "A required check is not pinned to the app that must report it, so anyone who can post a status or check run with that name can satisfy it, an agent included.",
  required_check_pinned_to_agent_app: "A required check is pinned to an agent app, so the agent reports its own check.",

  agent_app_id_mismatch:
    "A declared agent app's id differs from the id GitHub gives for its slug, so which app is the agent is unknown.",
  agent_app_ids_conflict:
    "One agent app slug is declared with different ids, in .github/darz.json or --agent-app, so which app is the agent is unknown.",
  agent_app_slugs_share_id:
    "Two different declared agent app slugs have the same app id, so at least one slug is wrong; Darz keeps one of them, and the agent's bot account may go unrecognised.",
  merges_unreadable: "The list of merged pull requests could not be read.",
  merges_incomplete:
    "Darz read closed pull requests up to its page cap and could not yet rule out a later merge, so the last N merged pull requests may be incomplete.",
  pull_request_files_unreadable: "The changed-file list of an agent pull request could not be read.",
  pull_request_files_truncated:
    "An agent pull request's file list reached GitHub's 3,000-file limit, so it may be incomplete; the gate files listed for it are a lower bound.",
  pull_request_reviews_unreadable: "The reviews of an agent pull request could not be read.",
  gate_candidate_at_merge_unreadable:
    "A package.json, vite.config.*, pyproject.toml or setup.cfg that an agent pull request changed could not be read or parsed as it was at the merge, so whether the pull request changed a gate file is unknown.",
  gate_candidates_at_merge_over_cap:
    "Agent pull requests changed more package.json, vite.config.*, pyproject.toml or setup.cfg files than Darz reads at merge commits, so for these pull requests whether they changed a gate file is unknown.",
};

export function reason(code: string, subjects?: string[]): Reason {
  const message = REASONS[code];
  if (message === undefined) throw new Error(`unknown reason code ${code}`);
  return subjects && subjects.length > 0 ? { code, message, subjects } : { code, message };
}

/** Collects reasons by code, keeping first-seen order and merging subjects. */
export class ReasonList {
  readonly #map = new Map<string, Set<string>>();

  add(code: string, ...subjects: string[]): this {
    let s = this.#map.get(code);
    if (!s) {
      s = new Set();
      this.#map.set(code, s);
    }
    for (const x of subjects) s.add(x);
    return this;
  }

  get size(): number {
    return this.#map.size;
  }

  has(code: string): boolean {
    return this.#map.has(code);
  }

  list(order?: readonly string[]): Reason[] {
    const codes = [...this.#map.keys()];
    if (order) codes.sort((a, b) => rank(order, a) - rank(order, b));
    return codes.map((c) => reason(c, [...(this.#map.get(c) ?? [])]));
  }
}

function rank(order: readonly string[], code: string): number {
  const i = order.indexOf(code);
  return i === -1 ? order.length : i;
}
