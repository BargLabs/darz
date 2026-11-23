// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// The default branch's effective protection, from two sources GitHub
// enforces together: the rules in effect (rulesets, repository and
// organisation) and classic branch protection. Each setting is three-valued:
// true (some source requires it), false (every source was read and none
// requires it), or null (no source requires it and at least one could not be
// read, or lacked the field).

import type { Snapshot } from "./github/snapshot.js";
import type { Rule } from "./github/types.js";

export type Tri = true | false | null;

export interface Setting {
  value: Tri;
  /** Why the value is null: reason codes, and for field_missing the field paths. */
  causes: string[];
  missingFields: string[];
  /** Endpoints that contributed. */
  read: string[];
}

function combine(parts: Array<{ value: Tri; cause?: string; field?: string; read?: string }>): Setting {
  const s: Setting = { value: false, causes: [], missingFields: [], read: [] };
  let anyNull = false;
  for (const p of parts) {
    if (p.read && !s.read.includes(p.read)) s.read.push(p.read);
    if (p.value === true) s.value = true;
    if (p.value === null) {
      anyNull = true;
      if (p.cause && !s.causes.includes(p.cause)) s.causes.push(p.cause);
      if (p.field && !s.missingFields.includes(p.field)) s.missingFields.push(p.field);
    }
  }
  if (s.value !== true && anyNull) s.value = null;
  if (s.value === true) {
    s.causes = [];
    s.missingFields = [];
  }
  return s;
}

function rulesEndpoint(snap: Snapshot): string | undefined {
  return snap.rules ? `GET ${snap.rules.endpoint}` : undefined;
}

function rulesOfType(snap: Snapshot, type: string): Rule[] | null {
  if (snap.rules?.state !== "read") return null;
  return (snap.rules.data ?? []).filter((r) => r.type === type);
}

type ReviewKey = "approvingReview" | "dismissStale" | "codeOwnerReview" | "lastPushApproval";

const RULE_FIELDS: Record<ReviewKey, string> = {
  approvingReview: "required_approving_review_count",
  dismissStale: "dismiss_stale_reviews_on_push",
  codeOwnerReview: "require_code_owner_review",
  lastPushApproval: "require_last_push_approval",
};

const CLASSIC_FIELDS: Record<ReviewKey, string> = {
  approvingReview: "required_approving_review_count",
  dismissStale: "dismiss_stale_reviews",
  codeOwnerReview: "require_code_owner_reviews",
  lastPushApproval: "require_last_push_approval",
};

function fieldValue(key: ReviewKey, obj: Record<string, unknown> | undefined, field: string): Tri {
  const v = obj?.[field];
  if (key === "approvingReview") return typeof v === "number" ? v >= 1 : null;
  return typeof v === "boolean" ? v : null;
}

/** Classic protection's part in a setting. */
function classicPart(snap: Snapshot): { state: "absent" | "unreadable" | "present"; read?: string } {
  const c = snap.classic;
  if (!c) return { state: "unreadable" };
  if (c.state === "present") return { state: "present", read: c.endpoint };
  if (c.state === "absent") return c.endpoint ? { state: "absent", read: c.endpoint } : { state: "absent" };
  return { state: "unreadable", read: c.endpoint };
}

export function reviewSetting(snap: Snapshot, key: ReviewKey): Setting {
  const parts: Array<{ value: Tri; cause?: string; field?: string; read?: string }> = [];
  const read = rulesEndpoint(snap);
  const prRules = rulesOfType(snap, "pull_request");
  if (prRules === null) parts.push({ value: null, cause: "rules_unreadable", ...(read ? { read } : {}) });
  else if (prRules.length === 0) parts.push({ value: false, ...(read ? { read } : {}) });
  else {
    for (const r of prRules) {
      const field = RULE_FIELDS[key];
      const v = fieldValue(key, r.parameters, field);
      parts.push(
        v === null
          ? { value: null, cause: "field_missing", field: `rules.pull_request.${field}`, ...(read ? { read } : {}) }
          : { value: v, ...(read ? { read } : {}) },
      );
    }
  }
  const cp = classicPart(snap);
  const cRead = cp.read ? { read: cp.read } : {};
  if (cp.state === "absent") parts.push({ value: false, ...cRead });
  else if (cp.state === "unreadable") parts.push({ value: null, cause: "classic_protection_unreadable", ...cRead });
  else if (snap.classic?.state === "present") {
    const reviews = snap.classic.data.required_pull_request_reviews;
    // GitHub omits required_pull_request_reviews when pull request reviews are not enabled.
    if (reviews === undefined || reviews === null) parts.push({ value: false, ...cRead });
    else {
      const field = CLASSIC_FIELDS[key];
      const v = fieldValue(key, reviews as Record<string, unknown>, field);
      parts.push(
        v === null
          ? { value: null, cause: "field_missing", field: `classic.required_pull_request_reviews.${field}`, ...cRead }
          : { value: v, ...cRead },
      );
    }
  }
  return combine(parts);
}

export function pullRequestRequired(snap: Snapshot): Setting {
  const parts: Array<{ value: Tri; cause?: string; read?: string }> = [];
  const read = rulesEndpoint(snap);
  const prRules = rulesOfType(snap, "pull_request");
  parts.push(
    prRules === null
      ? { value: null, cause: "rules_unreadable", ...(read ? { read } : {}) }
      : { value: prRules.length > 0, ...(read ? { read } : {}) },
  );
  const cp = classicPart(snap);
  const cRead = cp.read ? { read: cp.read } : {};
  if (cp.state === "absent") parts.push({ value: false, ...cRead });
  else if (cp.state === "unreadable") parts.push({ value: null, cause: "classic_protection_unreadable", ...cRead });
  else if (snap.classic?.state === "present") {
    const r = snap.classic.data.required_pull_request_reviews;
    parts.push({ value: r !== undefined && r !== null, ...cRead });
  }
  return combine(parts);
}

/**
 * A required check and the apps it is pinned to. An empty `appIds` means any
 * source may report it: anyone who can post a commit status or check run with
 * that name can satisfy it.
 */
export interface RequiredCheck {
  context: string;
  appIds: number[];
}

export interface StatusChecks {
  contexts: string[];
  checks: RequiredCheck[];
  strict: Tri;
  /** Null when no context was found and some source could not be read. */
  anyRequired: Tri;
  /**
   * True when a source could not be read or lacked a field, so a check could
   * be required, or pinned, by something Darz did not see.
   */
  incomplete: boolean;
  causes: string[];
  missingFields: string[];
  read: string[];
}

export function statusChecks(snap: Snapshot): StatusChecks {
  const pins = new Map<string, Set<number>>();
  const add = (context: unknown, appId: unknown) => {
    if (typeof context !== "string" || context.length === 0) return;
    let set = pins.get(context);
    if (!set) {
      set = new Set();
      pins.set(context, set);
    }
    // GitHub uses -1 in classic protection for "any source"; only a real app id pins.
    if (typeof appId === "number" && appId > 0) set.add(appId);
  };
  const strictParts: Array<{ value: Tri; cause?: string; read?: string }> = [];
  const out: StatusChecks = {
    contexts: [],
    checks: [],
    strict: null,
    anyRequired: false,
    incomplete: false,
    causes: [],
    missingFields: [],
    read: [],
  };
  const read = rulesEndpoint(snap);
  if (read) out.read.push(read);
  const missing = (field: string) => {
    out.incomplete = true;
    if (!out.causes.includes("field_missing")) out.causes.push("field_missing");
    out.missingFields.push(field);
  };
  const rules = rulesOfType(snap, "required_status_checks");
  if (rules === null) {
    out.incomplete = true;
    out.causes.push("rules_unreadable");
  } else {
    for (const r of rules) {
      const list = r.parameters?.required_status_checks;
      if (!Array.isArray(list)) {
        missing("rules.required_status_checks.required_status_checks");
        continue;
      }
      // GitHub leaves out integration_id when any source may report the check.
      for (const c of list) {
        const item = c as { context?: unknown; integration_id?: unknown };
        add(item?.context, item?.integration_id);
      }
      const strict = r.parameters?.strict_required_status_checks_policy;
      if (list.length > 0) strictParts.push({ value: typeof strict === "boolean" ? strict : null });
    }
  }
  const cp = classicPart(snap);
  if (cp.read) out.read.push(cp.read);
  if (cp.state === "unreadable") {
    out.incomplete = true;
    out.causes.push("classic_protection_unreadable");
    strictParts.push({ value: null });
  } else if (snap.classic?.state === "present") {
    const rsc = snap.classic.data.required_status_checks;
    // GitHub omits required_status_checks when no status checks are required.
    if (rsc !== undefined && rsc !== null) {
      const before = pins.size;
      if (Array.isArray(rsc.checks)) {
        // checks carries each check's app_id (null for any source).
        for (const c of rsc.checks) add(c?.context, c?.app_id);
      } else if (Array.isArray(rsc.contexts)) {
        // The legacy contexts list carries no source: every entry is unpinned.
        for (const c of rsc.contexts) add(c, undefined);
      } else {
        missing("classic.required_status_checks.checks");
      }
      if (pins.size > before || (Array.isArray(rsc.contexts) && rsc.contexts.length > 0)) {
        strictParts.push({ value: typeof rsc.strict === "boolean" ? rsc.strict : null });
      }
    }
  }
  out.contexts = [...pins.keys()].sort();
  out.checks = out.contexts.map((context) => ({
    context,
    appIds: [...(pins.get(context) ?? [])].sort((a, b) => a - b),
  }));
  out.anyRequired = out.contexts.length > 0 ? true : out.incomplete ? null : false;
  out.strict = combine(strictParts).value;
  return out;
}
