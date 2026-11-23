// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { ownerKind, ownersOf, parseCodeowners } from "../codeowners.js";
import { MAX_CANDIDATE_READS, gateFilesIn, isGatePathForChange } from "../gates.js";
import { codeownersErrorsInUse, errorLines } from "../github/snapshot.js";
import { appLabel, identityName, matchLogin } from "../identities.js";
import { pullRequestRequired, reviewSetting, statusChecks } from "../protection.js";
import { ReasonList, reason } from "./reasons.js";
import { CHECK_IDS, CHECK_TITLES } from "./types.js";
function makeRow(id, status, reasons, read, context = [], details) {
    const row = {
        id,
        title: CHECK_TITLES[id],
        status,
        reasons,
        read: [...new Set(read)],
        context,
    };
    if (details !== undefined)
        row.details = details;
    return row;
}
/** fail if any fail reason, else unverifiable if any unknown, else pass. */
function decide(fails, unknowns, order) {
    if (fails.size > 0)
        return { status: "fail", reasons: fails.list(order) };
    if (unknowns.size > 0)
        return { status: "unverifiable", reasons: unknowns.list(order) };
    return { status: "pass", reasons: [] };
}
function addSettingUnknown(unknowns, s) {
    for (const c of s.causes) {
        if (c === "field_missing")
            unknowns.add(c, ...s.missingFields);
        else
            unknowns.add(c);
    }
}
function configUnknown(snap, unknowns, read) {
    const c = snap.config;
    if (c.state === "not_read")
        return;
    read.push(c.endpoint);
    if (c.state === "invalid")
        unknowns.add("config_invalid", c.problem);
    if (c.state === "unreadable")
        unknowns.add("config_unreadable");
}
/** Everything checks 1 and 3 need about the tree and CODEOWNERS. */
function ownership(input) {
    const { snap } = input;
    const unknowns = new ReasonList();
    const read = [];
    const out = {
        gateFiles: null,
        owners: null,
        codeownersPath: null,
        ignored: [],
        candidatesWithoutTestSettings: [],
        unknowns,
        read,
    };
    let treePaths = null;
    if (snap.tree)
        read.push(`GET ${snap.tree.endpoint}`);
    if (!snap.tree || snap.tree.state !== "read")
        unknowns.add("tree_unreadable");
    else {
        const t = snap.tree.data;
        if (typeof t?.truncated !== "boolean" || !Array.isArray(t.tree))
            unknowns.add("field_missing", "tree.truncated");
        else if (t.truncated)
            unknowns.add("tree_truncated");
        else
            treePaths = t.tree
                .filter((e) => e.type === "blob" && typeof e.path === "string")
                .map((e) => e.path);
    }
    const co = snap.codeowners;
    read.push(...co.endpoints);
    let codeownersKnown = false;
    let file = null;
    if (co.state === "unreadable")
        unknowns.add("codeowners_unreadable");
    else if (co.state === "none")
        codeownersKnown = true;
    else if (co.state === "found") {
        out.codeownersPath = co.path;
        read.push(co.path);
        if (snap.codeownersErrors)
            read.push(`GET ${snap.codeownersErrors.endpoint}`);
        const errors = codeownersErrorsInUse(snap);
        if (errors === null)
            unknowns.add("codeowners_errors_unreadable");
        else {
            file = parseCodeowners(co.text, errorLines(errors));
            const kinds = new Map(errors.map((e) => [e.line, e.kind ?? "error"]));
            out.ignored = file.ignoredLines.map((l) => ({ ...l, kind: String(kinds.get(l.line) ?? "error") }));
            codeownersKnown = true;
        }
    }
    if (treePaths !== null && codeownersKnown && configKnown(snap)) {
        out.gateFiles = gateFilesIn(input.gates, treePaths);
        const cand = snap.candidates;
        if (cand.state === "over_cap") {
            unknowns.add("gate_candidates_over_cap", `${cand.count} candidates; at most ${MAX_CANDIDATE_READS} are read`);
        }
        else if (cand.state === "read") {
            for (const c of cand.results)
                read.push(c.endpoint);
            const unreadable = cand.results.filter((c) => c.state === "unreadable").map((c) => c.path);
            if (unreadable.length > 0)
                unknowns.add("gate_candidate_unreadable", ...unreadable);
            out.candidatesWithoutTestSettings = cand.results.filter((c) => c.state === "not_gate").map((c) => c.path);
        }
        if (file !== null) {
            const f = file;
            out.owners = new Map(out.gateFiles.map((g) => [g, ownersOf(f, g)]));
        }
    }
    return out;
}
function configKnown(snap) {
    return snap.config.state === "valid" || snap.config.state === "absent";
}
const ORDER_1 = [
    "gate_files_unowned",
    "no_codeowners_file",
    "code_owner_review_not_required",
    "tree_unreadable",
    "tree_truncated",
    "codeowners_unreadable",
    "codeowners_errors_unreadable",
    "codeowners_error_ambiguous",
    "gate_candidate_unreadable",
    "gate_candidates_over_cap",
    "config_invalid",
    "config_unreadable",
    "rules_unreadable",
    "classic_protection_unreadable",
    "field_missing",
];
export function checkGateFilesOwned(input, own) {
    const { snap } = input;
    const fails = new ReasonList();
    const unknowns = new ReasonList();
    const read = [...own.read];
    const context = [];
    own.unknowns.list().forEach((r) => unknowns.add(r.code, ...(r.subjects ?? [])));
    configUnknown(snap, unknowns, read);
    let teamOwners = [];
    if (own.gateFiles !== null) {
        const unowned = [];
        const ambiguous = [];
        const unresolved = new Set();
        for (const f of own.gateFiles) {
            const o = own.owners?.get(f);
            if (o === undefined) {
                unowned.push(f);
                continue;
            }
            if (o.ambiguous)
                ambiguous.push(f);
            else if (o.owners.length === 0)
                unowned.push(f);
            for (const w of o.owners)
                if (ownerKind(w) !== "user")
                    unresolved.add(w);
        }
        if (unowned.length > 0)
            fails.add("gate_files_unowned", ...unowned);
        else if (own.gateFiles.length === 0 && own.owners === null)
            fails.add("no_codeowners_file");
        if (ambiguous.length > 0)
            unknowns.add("codeowners_error_ambiguous", ...ambiguous);
        teamOwners = [...unresolved].sort();
    }
    const cor = reviewSetting(snap, "codeOwnerReview");
    read.push(...cor.read);
    if (cor.value === false)
        fails.add("code_owner_review_not_required");
    else if (cor.value === null)
        addSettingUnknown(unknowns, cor);
    if (teamOwners.length > 0) {
        context.push(`Gate files are owned by ${teamOwners.join(", ")}, reported as written; their members were not read.`);
    }
    if (own.ignored.length > 0) {
        context.push(`GitHub reports ${own.ignored.length} CODEOWNERS line(s) as errors; they do not count as owners.`);
    }
    const d = decide(fails, unknowns, ORDER_1);
    const details = {
        codeownersFile: own.codeownersPath,
        gateFiles: own.gateFiles,
        ignoredCodeownersLines: own.ignored,
        candidatesWithoutTestSettings: own.candidatesWithoutTestSettings,
    };
    return makeRow("gate_files_owned", d.status, d.reasons, read, context, details);
}
const ORDER_2 = [
    "no_pull_request_rule",
    "approving_review_not_required",
    "stale_reviews_not_dismissed",
    "last_push_approval_not_required",
    "rules_unreadable",
    "classic_protection_unreadable",
    "field_missing",
];
export function checkHumanReviewRequired(input) {
    const { snap } = input;
    const fails = new ReasonList();
    const unknowns = new ReasonList();
    const read = [];
    const pr = pullRequestRequired(snap);
    read.push(...pr.read);
    const settings = [
        ["approving_review_not_required", reviewSetting(snap, "approvingReview")],
        ["stale_reviews_not_dismissed", reviewSetting(snap, "dismissStale")],
        ["last_push_approval_not_required", reviewSetting(snap, "lastPushApproval")],
    ];
    if (pr.value === false)
        fails.add("no_pull_request_rule");
    else {
        for (const [code, s] of settings) {
            read.push(...s.read);
            if (s.value === false)
                fails.add(code);
            else if (s.value === null)
                addSettingUnknown(unknowns, s);
        }
    }
    const d = decide(fails, unknowns, ORDER_2);
    return makeRow("human_review_required", d.status, d.reasons, read);
}
/**
 * A declared app whose slug `GET /apps/{slug}` did not resolve: the slug may be
 * misspelt or the read failed, so every check about it may be about no app at all.
 */
function unresolvedApps(input, unknowns, read) {
    for (const id of input.identities) {
        if (id.kind !== "app" || id.source !== "declared" || id.slug === undefined)
            continue;
        const r = input.appLookups.get(id.slug.toLowerCase());
        if (id.appId !== undefined) {
            // The id is declared, or resolved by the lookup. If the lookup was read and
            // names a different app, the declaration and GitHub disagree (issue 30).
            const found = r?.state === "read" ? r.data?.id : undefined;
            if (typeof found === "number" && found !== id.appId) {
                if (r)
                    read.push(`GET ${r.endpoint}`);
                unknowns.add("agent_app_id_mismatch", `${id.slug} (declared ${id.appId}, GitHub says ${found})`);
            }
            continue;
        }
        if (r)
            read.push(`GET ${r.endpoint}`);
        const why = !r ? "not read" : r.state === "read" ? "no app id in the response" : r.status === null ? r.state : `${r.state}, ${r.status}`;
        unknowns.add("agent_app_unresolved", `${id.slug} (${why})`);
    }
}
/**
 * No agent identities: the row cannot pass. If .github/darz.json could not be
 * used, say so too, since that is where agents would have been declared.
 */
function identitiesUnverifiable(id, identities, snap) {
    if (identities.length > 0)
        return null;
    const unknowns = new ReasonList().add("no_agent_identities");
    const read = [];
    configUnknown(snap, unknowns, read);
    return makeRow(id, "unverifiable", unknowns.list(), read);
}
const ORDER_3 = [
    "agent_is_code_owner",
    "last_push_approval_not_required",
    "tree_unreadable",
    "tree_truncated",
    "codeowners_unreadable",
    "codeowners_errors_unreadable",
    "codeowners_error_ambiguous",
    "gate_candidate_unreadable",
    "gate_candidates_over_cap",
    "unresolved_owners",
    "agent_app_unresolved",
    "agent_app_id_mismatch",
    "config_invalid",
    "config_unreadable",
    "rules_unreadable",
    "classic_protection_unreadable",
    "field_missing",
];
export function checkWriterNotApprover(input, own) {
    const { snap, identities } = input;
    const empty = identitiesUnverifiable("writer_not_approver", identities, snap);
    if (empty)
        return empty;
    const fails = new ReasonList();
    const unknowns = new ReasonList();
    const read = [...own.read];
    configUnknown(snap, unknowns, read);
    unresolvedApps(input, unknowns, read);
    own.unknowns.list().forEach((r) => unknowns.add(r.code, ...(r.subjects ?? [])));
    const lp = reviewSetting(snap, "lastPushApproval");
    read.push(...lp.read);
    if (lp.value === false)
        fails.add("last_push_approval_not_required");
    else if (lp.value === null)
        addSettingUnknown(unknowns, lp);
    const hasUserAgent = identities.some((i) => i.kind === "user");
    if (own.owners !== null) {
        const byAgent = new Map();
        const unresolved = new Set();
        const ambiguous = [];
        for (const [f, o] of own.owners) {
            if (o.ambiguous) {
                ambiguous.push(f);
                continue;
            }
            for (const w of o.owners) {
                const kind = ownerKind(w);
                if (kind !== "user") {
                    unresolved.add(w);
                    continue;
                }
                const agent = matchLogin(identities, w.slice(1));
                if (agent) {
                    const name = identityName(agent);
                    byAgent.set(name, [...(byAgent.get(name) ?? []), f]);
                }
            }
        }
        for (const [name, files] of [...byAgent.entries()].sort()) {
            fails.add("agent_is_code_owner", `${name}: ${files.join(", ")}`);
        }
        if (ambiguous.length > 0)
            unknowns.add("codeowners_error_ambiguous", ...ambiguous);
        if (unresolved.size > 0 && hasUserAgent)
            unknowns.add("unresolved_owners", ...[...unresolved].sort());
    }
    const context = [
        "GitHub never counts a pull request author's own approval toward required reviews; that is GitHub's behaviour, not this check.",
    ];
    const d = decide(fails, unknowns, ORDER_3);
    return makeRow("writer_not_approver", d.status, d.reasons, read, context);
}
const LEVELS = ["read", "triage", "write", "maintain", "admin"];
const ORDER_4 = [
    "agent_app_can_bypass",
    "agent_role_can_bypass",
    "agent_is_admin",
    "admins_not_enforced_agent_is_admin",
    "agent_in_bypass_allowance",
    "rules_unreadable",
    "ruleset_unreadable",
    "bypass_list_unreadable",
    "bypass_role_unknown",
    "bypass_actor_unknown",
    "team_bypass_members_unread",
    "collaborators_unreadable",
    "classic_protection_unreadable",
    "field_missing",
    "agent_app_unresolved",
    "agent_app_id_mismatch",
    "config_invalid",
    "config_unreadable",
];
export function checkAgentsCannotBypass(input) {
    const { snap, identities } = input;
    const empty = identitiesUnverifiable("agents_cannot_bypass", identities, snap);
    if (empty)
        return empty;
    const fails = new ReasonList();
    const unknowns = new ReasonList();
    const read = [];
    const context = [];
    configUnknown(snap, unknowns, read);
    unresolvedApps(input, unknowns, read);
    const hasUserAgent = identities.some((i) => i.kind === "user");
    // Agent permission levels, from the collaborators list.
    const levels = new Map();
    let collaboratorsKnown = false;
    if (snap.collaborators)
        read.push(`GET ${snap.collaborators.endpoint}`);
    if (snap.collaborators?.state === "read") {
        collaboratorsKnown = true;
        for (const id of identities)
            levels.set(id, null);
        for (const c of snap.collaborators.data ?? []) {
            if (typeof c.login !== "string")
                continue;
            const agent = matchLogin(identities, c.login);
            if (!agent)
                continue;
            levels.set(agent, levelOf(c));
        }
    }
    else {
        unknowns.add("collaborators_unreadable");
    }
    const atLeast = (lvl) => identities.filter((i) => {
        const l = levels.get(i);
        return l !== undefined && l !== null && LEVELS.indexOf(l) >= LEVELS.indexOf(lvl);
    });
    if (snap.rules)
        read.push(`GET ${snap.rules.endpoint}`);
    if (snap.rules?.state !== "read")
        unknowns.add("rules_unreadable");
    else {
        for (const [id, rs] of snap.rulesets) {
            read.push(`GET ${rs.endpoint}`);
            if (rs.state !== "read") {
                unknowns.add("ruleset_unreadable", `ruleset ${id}`);
                continue;
            }
            const actors = rs.data?.bypass_actors;
            if (!Array.isArray(actors)) {
                unknowns.add("bypass_list_unreadable", `ruleset ${id}`);
                continue;
            }
            for (const a of actors) {
                const where = `ruleset ${id}`;
                switch (a.actor_type) {
                    case "Integration": {
                        const agent = identities.find((i) => i.kind === "app" && i.appId === a.actor_id);
                        const label = agent ? appLabel(agent) : `app id ${a.actor_id}`;
                        fails.add("agent_app_can_bypass", `${label} on ${where}`);
                        break;
                    }
                    case "RepositoryRole": {
                        // GitHub does not document which actor_id is which built-in
                        // repository role (issue 4), so Darz cannot tell whether a role
                        // bypass covers an agent's permission. Any agent that holds a
                        // repository permission might hold the role, so the row cannot pass.
                        if (!collaboratorsKnown)
                            break;
                        const holders = identities.filter((i) => {
                            const l = levels.get(i);
                            return l !== undefined && l !== null;
                        });
                        if (holders.length > 0) {
                            const who = holders.map((h) => `${identityName(h)} has ${levels.get(h)}`).join(", ");
                            unknowns.add("bypass_role_unknown", `role id ${a.actor_id} on ${where}; ${who}`);
                        }
                        break;
                    }
                    case "OrganizationAdmin": {
                        if (!collaboratorsKnown)
                            break;
                        for (const agent of atLeast("admin")) {
                            fails.add("agent_role_can_bypass", `${identityName(agent)} (admin) is covered by organisation admin bypass on ${where}`);
                        }
                        break;
                    }
                    case "Team":
                        if (hasUserAgent)
                            unknowns.add("team_bypass_members_unread", `team id ${a.actor_id} on ${where}`);
                        else
                            context.push(`Team id ${a.actor_id} can bypass ${where}; its members were not read.`);
                        break;
                    case "DeployKey":
                        context.push(`Deploy keys can bypass ${where}.`);
                        break;
                    default:
                        unknowns.add("bypass_actor_unknown", `${String(a.actor_type)} on ${where}`);
                }
            }
        }
    }
    const admins = collaboratorsKnown ? atLeast("admin") : [];
    for (const a of admins)
        fails.add("agent_is_admin", identityName(a));
    const c = snap.classic;
    if (c && c.endpoint)
        read.push(c.endpoint);
    if (!c || c.state === "unreadable")
        unknowns.add("classic_protection_unreadable");
    else if (c.state === "present") {
        const enforced = c.data.enforce_admins?.enabled;
        if (admins.length > 0) {
            if (enforced === false)
                for (const a of admins)
                    fails.add("admins_not_enforced_agent_is_admin", identityName(a));
            else if (typeof enforced !== "boolean")
                unknowns.add("field_missing", "classic.enforce_admins.enabled");
        }
        const reviews = c.data.required_pull_request_reviews;
        if (reviews) {
            // GitHub leaves bypass_pull_request_allowances out when there are none
            // (issue 3, seen on a live repository); a value of another shape is unknown.
            const allow = reviews.bypass_pull_request_allowances;
            if (allow !== undefined && (allow === null || typeof allow !== "object")) {
                unknowns.add("field_missing", "classic.required_pull_request_reviews.bypass_pull_request_allowances");
            }
            else if (allow !== undefined) {
                for (const u of allow.users ?? []) {
                    const agent = typeof u.login === "string" ? matchLogin(identities, u.login) : undefined;
                    if (agent)
                        fails.add("agent_in_bypass_allowance", identityName(agent));
                }
                for (const app of allow.apps ?? []) {
                    const agent = identities.find((i) => i.kind === "app" &&
                        ((app.slug !== undefined && i.slug?.toLowerCase() === app.slug.toLowerCase()) ||
                            (app.id !== undefined && i.appId === app.id)));
                    if (agent)
                        fails.add("agent_in_bypass_allowance", appLabel(agent));
                }
                if ((allow.teams ?? []).length > 0 && hasUserAgent) {
                    unknowns.add("team_bypass_members_unread", ...(allow.teams ?? []).map((t) => `team ${t.slug} in classic bypass allowance`));
                }
            }
        }
    }
    context.push("GitHub App installation permissions (for example administration: write) are not readable with a user token and were not checked.");
    const d = decide(fails, unknowns, ORDER_4);
    return makeRow("agents_cannot_bypass", d.status, d.reasons, read, context);
}
function levelOf(c) {
    const p = c.permissions;
    if (p) {
        if (p.admin)
            return "admin";
        if (p.maintain)
            return "maintain";
        if (p.push)
            return "write";
        if (p.triage)
            return "triage";
        if (p.pull)
            return "read";
    }
    const r = c.role_name;
    return LEVELS.includes(r ?? "") ? r : null;
}
/**
 * Check 5. A required check only fails closed if a named app must report it:
 * an unpinned check can be satisfied by anyone who can post a status or check
 * run with that name, an agent included. Every required check must be pinned,
 * none to an agent app. A source Darz could not read could pin a check or
 * require another one, so with a source unreadable the row cannot pass.
 */
export function checkRequiredChecks(input) {
    const sc = statusChecks(input.snap);
    const fails = new ReasonList();
    const unknowns = new ReasonList();
    const read = [...sc.read];
    const unknownCauses = () => {
        for (const c of sc.causes) {
            if (c === "field_missing")
                unknowns.add(c, ...sc.missingFields);
            else
                unknowns.add(c);
        }
    };
    if (sc.anyRequired === false)
        fails.add("no_required_checks");
    else if (sc.anyRequired === null)
        unknownCauses();
    else {
        for (const check of sc.checks) {
            for (const appId of check.appIds) {
                const agent = input.identities.find((i) => i.kind === "app" && i.appId === appId);
                if (agent)
                    fails.add("required_check_pinned_to_agent_app", `${check.context}: ${appLabel(agent)}`);
            }
        }
        const unpinned = sc.checks.filter((c) => c.appIds.length === 0).map((c) => c.context);
        if (unpinned.length > 0 && !sc.incomplete)
            fails.add("required_check_unpinned", ...unpinned);
        if (sc.incomplete)
            unknownCauses();
    }
    const d = decide(fails, unknowns, [
        "no_required_checks",
        "required_check_pinned_to_agent_app",
        "required_check_unpinned",
        "rules_unreadable",
        "classic_protection_unreadable",
        "field_missing",
    ]);
    const details = { requiredChecks: sc.checks, mustBeUpToDate: sc.strict === null ? "unknown" : sc.strict };
    return makeRow("required_checks_fail_closed", d.status, d.reasons, read, [], details);
}
/** GitHub's list of a pull request's files stops at 3,000 entries without saying so. */
export const PULL_REQUEST_FILES_CAP = 3000;
export function checkAgentMerges(input) {
    const { snap, identities } = input;
    const empty = identitiesUnverifiable("agent_merges_touching_gates", identities, snap);
    if (empty)
        return empty;
    const unknowns = new ReasonList();
    const read = [];
    configUnknown(snap, unknowns, read);
    unresolvedApps(input, unknowns, read);
    const m = snap.merges;
    if (m.pulls)
        read.push(`GET ${m.pulls.endpoint}`);
    if (m.pulls?.state !== "read") {
        unknowns.add("merges_unreadable");
        const d = decide(new ReasonList(), unknowns, ["merges_unreadable", "agent_app_unresolved"]);
        return makeRow("agent_merges_touching_gates", d.status, d.reasons, read);
    }
    const prs = [];
    for (const p of m.merged) {
        const login = p.user?.login;
        if (typeof login !== "string" || !matchLogin(identities, login))
            continue;
        const n = p.number;
        const detail = input.pullDetails.get(n);
        let gateFilesChanged = null;
        let approvers = null;
        let fileListTruncated = false;
        if (detail) {
            read.push(`GET ${detail.files.endpoint}`, `GET ${detail.reviews.endpoint}`);
            if (detail.files.state === "read") {
                const changed = new Set();
                const list = detail.files.data ?? [];
                if (list.length >= PULL_REQUEST_FILES_CAP) {
                    fileListTruncated = true;
                    unknowns.add("pull_request_files_truncated", `#${n}`);
                }
                for (const f of list) {
                    for (const path of [f.filename, f.previous_filename]) {
                        if (typeof path === "string" && isGatePathForChange(input.gates, path))
                            changed.add(path);
                    }
                }
                gateFilesChanged = [...changed].sort();
            }
            else
                unknowns.add("pull_request_files_unreadable", `#${n}`);
            if (detail.reviews.state === "read")
                approvers = latestApprovers(detail.reviews.data ?? []);
            else
                unknowns.add("pull_request_reviews_unreadable", `#${n}`);
        }
        else {
            unknowns.add("pull_request_files_unreadable", `#${n}`);
        }
        prs.push({
            number: n,
            url: typeof p.html_url === "string" ? p.html_url : null,
            author: login,
            mergedAt: p.merged_at ?? null,
            gateFilesChanged,
            fileListTruncated,
            approvers,
        });
    }
    const context = ["Counts and links only; no judgement of intent."];
    if (m.merged.length < m.requested) {
        context.push(`${m.merged.length} merged pull requests were read; ${m.requested} were requested.`);
    }
    const details = {
        requested: m.requested,
        mergedRead: m.merged.length,
        agentMerges: prs.length,
        agentMergesTouchingGates: prs.filter((p) => Array.isArray(p.gateFilesChanged) && p.gateFilesChanged.length > 0).length,
        pullRequests: prs,
    };
    const status = unknowns.size > 0 ? "unverifiable" : "context";
    const reasons = unknowns.list([
        "merges_unreadable",
        "pull_request_files_unreadable",
        "pull_request_files_truncated",
        "pull_request_reviews_unreadable",
        "agent_app_unresolved",
        "agent_app_id_mismatch",
        "config_invalid",
        "config_unreadable",
    ]);
    return makeRow("agent_merges_touching_gates", status, reasons, read, context, details);
}
/** Each reviewer's latest review that sets a state; COMMENTED and PENDING do not. */
export function latestApprovers(reviews) {
    const latest = new Map();
    for (const r of reviews) {
        const login = r.user?.login;
        if (typeof login !== "string" || typeof r.state !== "string")
            continue;
        if (r.state === "COMMENTED" || r.state === "PENDING")
            continue;
        latest.set(login, r.state);
    }
    return [...latest.entries()].filter(([, s]) => s === "APPROVED").map(([l]) => l).sort();
}
export function repositoryUnreadableRows(snap) {
    return CHECK_IDS.map((id) => makeRow(id, "unverifiable", [reason("repository_unreadable")], [snap.repoEndpoint]));
}
export function evaluate(input) {
    if (!input.snap.repositoryReadable)
        return repositoryUnreadableRows(input.snap);
    const own = ownership(input);
    return [
        checkGateFilesOwned(input, own),
        checkHumanReviewRequired(input),
        checkWriterNotApprover(input, own),
        checkAgentsCannotBypass(input),
        checkRequiredChecks(input),
        checkAgentMerges(input),
    ];
}
