// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// The subset of GitHub REST response fields Darz reads. Every field is
// optional: a field missing from a read response is unverifiable, so the
// code that reads it must check its type, never assume it.

export interface RepoData {
  full_name?: string;
  default_branch?: string;
  private?: boolean;
  owner?: { login?: string; type?: string };
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

export interface BranchData {
  name?: string;
  commit?: { sha?: string };
  protected?: boolean;
}

export interface TreeEntry {
  path?: string;
  type?: string;
  sha?: string;
}

export interface TreeData {
  sha?: string;
  tree?: TreeEntry[];
  truncated?: boolean;
}

export interface ContentData {
  type?: string;
  encoding?: string;
  content?: string;
}

export interface CodeownersErrorData {
  line?: number;
  column?: number;
  kind?: string;
  source?: string;
  path?: string;
  message?: string;
}

export interface Rule {
  type?: string;
  parameters?: Record<string, unknown>;
  ruleset_id?: number;
  ruleset_source_type?: string;
  ruleset_source?: string;
}

export interface BypassActor {
  actor_id?: number | null;
  actor_type?: string;
  bypass_mode?: string;
}

export interface RulesetData {
  id?: number;
  name?: string;
  source_type?: string;
  source?: string;
  enforcement?: string;
  bypass_actors?: BypassActor[];
}

export interface ClassicProtectionData {
  required_status_checks?: {
    strict?: boolean;
    contexts?: string[];
    checks?: Array<{ context?: string; app_id?: number | null }>;
  } | null;
  enforce_admins?: { enabled?: boolean } | null;
  required_pull_request_reviews?: {
    required_approving_review_count?: number;
    dismiss_stale_reviews?: boolean;
    require_code_owner_reviews?: boolean;
    require_last_push_approval?: boolean;
    bypass_pull_request_allowances?: {
      users?: Array<{ login?: string; type?: string }>;
      teams?: Array<{ slug?: string }>;
      apps?: Array<{ slug?: string; id?: number }>;
    };
  } | null;
}

export interface CollaboratorData {
  login?: string;
  type?: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
  role_name?: string;
}

export interface PullData {
  number?: number;
  html_url?: string;
  user?: { login?: string; type?: string } | null;
  merged_at?: string | null;
  updated_at?: string | null;
  merge_commit_sha?: string | null;
}

export interface GitCommitData {
  sha?: string;
  parents?: Array<{ sha?: string }>;
}

export interface PullFileData {
  filename?: string;
  previous_filename?: string;
  status?: string;
  /** The file's blob; for a removed file, the blob the pull request removed. */
  sha?: string;
}

export interface ReviewData {
  user?: { login?: string; type?: string } | null;
  state?: string;
}

export interface AppData {
  id?: number;
  slug?: string;
}

/** `GET /orgs/{org}/memberships/{username}`. An owner has role `admin`. */
export interface OrgMembershipData {
  role?: string;
  state?: string;
}

/** One entry of `GET /orgs/{org}/installations`. */
export interface InstallationData {
  id?: number;
  app_id?: number;
  app_slug?: string;
  repository_selection?: string;
  permissions?: Record<string, string>;
}
