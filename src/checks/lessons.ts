// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { globMatches } from "../gates.js";
import type { ApprovalRead, LessonFileRead, LessonsRead, TargetsRead } from "../github/lessons.js";
import { type AgentIdentity, isBotLogin, matchLogin } from "../identities.js";
import { type Lesson, LESSONS_DIR, MAX_LESSONS, MAX_LESSON_FILE_READS, lineMatcher, scanText } from "../lessons.js";
import { ReasonList } from "./reasons.js";
import { CHECK_TITLES, type CheckRow, type CheckStatus, type Reason } from "./types.js";

/** Findings listed per lesson, in the record and in SARIF; the count is always given. */
export const MAX_FINDINGS_LISTED = 50;

export type LessonStatus = "pass" | "fail" | "unverifiable" | "not_in_force";

/**
 * Where a lesson does not hold: a matching line, a file with none, or no file
 * at all (then `path` is the lesson's globs).
 */
export interface Finding {
  path: string;
  line: number | null;
  what: "match" | "no_matching_line" | "no_matching_files";
}

export interface LessonResult {
  id: string | null;
  file: string;
  status: LessonStatus;
  reasons: Reason[];
  approvers: string[];
  approval: { commit: string | null; pullRequest: number | null } | null;
  findings: Finding[];
  findingCount: number;
}

type Approval =
  | { state: "approved"; approvers: string[] }
  | { state: "unapproved"; why: string }
  | { state: "unreadable"; why: string };

const STATE_SETTING = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * Was the latest change to a lesson file approved? Only by a person: on the
 * pull request's final head, as that reviewer's latest review that sets a
 * state, by someone who is neither the pull request's author nor an agent
 * identity nor a bot account.
 */
export function judgeApproval(a: ApprovalRead | null, identities: readonly AgentIdentity[]): Approval {
  if (a === null) return { state: "unreadable", why: "not read" };
  if (a.commits.state !== "read") return { state: "unreadable", why: "its latest commit could not be read" };
  if (a.commit === null) return { state: "unreadable", why: "its latest commit is not in the response" };
  const c = a.commit.slice(0, 12);
  if (a.pulls === null || a.pulls.state !== "read") return { state: "unreadable", why: `the pull requests of ${c} could not be read` };
  if (a.choice === "none") return { state: "unapproved", why: `no_pull_request: ${c} was not merged by a pull request into the default branch` };
  if (a.choice !== "one" || a.pull === null) return { state: "unreadable", why: `several merged pull requests contain ${c}` };
  const p = a.pull;
  const n = p.number as number;
  const head = p.head?.sha;
  const author = p.user?.login;
  if (typeof head !== "string" || typeof author !== "string") {
    return { state: "unreadable", why: `pull request ${n} has no head commit or author in the response` };
  }
  if (a.reviews === null || a.reviews.state !== "read") return { state: "unreadable", why: `the reviews of pull request ${n} could not be read` };

  const latest = new Map<string, { login: string; state: string; commit: unknown; bot: boolean }>();
  for (const r of a.reviews.data ?? []) {
    const login = r.user?.login;
    if (typeof login !== "string" || typeof r.state !== "string" || !STATE_SETTING.has(r.state)) continue;
    latest.set(login.toLowerCase(), { login, state: r.state, commit: r.commit_id, bot: r.user?.type === "Bot" || isBotLogin(login) });
  }
  const approvals = [...latest.values()].filter((r) => r.state === "APPROVED");
  const byAuthor = (r: { login: string }) => r.login.toLowerCase() === author.toLowerCase();
  const byAgent = (r: { login: string; bot: boolean }) => r.bot || matchLogin(identities, r.login) !== undefined;
  const counting = approvals.filter((r) => r.commit === head && !byAuthor(r) && !byAgent(r));
  if (counting.length > 0) return { state: "approved", approvers: counting.map((r) => r.login).sort() };

  if (approvals.length === 0) return { state: "unapproved", why: `pull request ${n} has no approval` };
  const kinds = new Set<string>();
  for (const r of approvals) {
    if (byAuthor(r)) kinds.add("its author");
    else if (byAgent(r)) kinds.add("an agent identity or bot");
    else kinds.add("an earlier head");
  }
  const by = [...kinds].filter((k) => k !== "an earlier head");
  const parts = [
    ...(by.length > 0 ? [`approved only by ${by.join(" or ")}`] : []),
    ...(kinds.has("an earlier head") ? ["approved only on an earlier head"] : []),
  ];
  return { state: "unapproved", why: `pull request ${n} was ${parts.join(", or ")}` };
}

interface Run {
  status: "pass" | "fail" | "unverifiable";
  reasons: ReasonList;
  findings: Finding[];
  read: string[];
}

/** Run one approved lesson over the files at the commit read. */
function runLesson(lesson: Lesson, targets: TargetsRead, ref: string): Run {
  const reasons = new ReasonList();
  const read: string[] = [`GET ${targets.endpoint}`];
  const findings: Finding[] = [];
  const id = lesson.id;
  if (targets.state === "tree_unreadable" || targets.state === "tree_truncated") {
    return { status: "unverifiable", reasons: reasons.add(targets.state, `at ${ref}`), findings, read };
  }
  if (targets.state === "over_cap") {
    reasons.add("lesson_read_cap", `${targets.files} files to read; at most ${MAX_LESSON_FILE_READS} are read`);
    return { status: "unverifiable", reasons, findings, read };
  }
  const matches = lineMatcher(lesson.check);
  const paths = targets.paths.filter((p) => lesson.check.paths.some((g) => globMatches(g, p)));
  if (lesson.check.kind === "require" && paths.length === 0) {
    findings.push({ path: lesson.check.paths.join(", "), line: null, what: "no_matching_files" });
  }
  let unknown = false;
  for (const path of paths) {
    const f = targets.files.get(path);
    if (f?.endpoint) read.push(`GET ${f.endpoint}`);
    if (f === undefined || f.state === "unreadable") {
      reasons.add("lesson_file_unreadable", `${id}: ${path}`);
      unknown = true;
      continue;
    }
    if (f.state === "too_large") {
      reasons.add("file_too_large", `${id}: ${path} (${f.why})`);
      unknown = true;
      continue;
    }
    const scan = scanText(f.text, matches);
    if (scan.state === "too_large") {
      reasons.add("file_too_large", `${id}: ${path} (${scan.why})`);
      unknown = true;
      continue;
    }
    if (lesson.check.kind === "forbid") for (const line of scan.lines) findings.push({ path, line, what: "match" });
    else if (scan.lines.length === 0) findings.push({ path, line: null, what: "no_matching_line" });
  }
  if (findings.length > 0) {
    for (const f of findings.slice(0, MAX_FINDINGS_LISTED)) {
      reasons.add(
        "lesson_violated",
        f.what === "match" ? `${id}: ${f.path}:${f.line}` : f.what === "no_matching_line" ? `${id}: ${f.path} has no matching line` : `${id}: no_matching_files`,
      );
    }
    if (findings.length > MAX_FINDINGS_LISTED) reasons.add("lesson_violated", `${id}: ${findings.length - MAX_FINDINGS_LISTED} more`);
    return { status: "fail", reasons, findings, read };
  }
  return { status: unknown ? "unverifiable" : "pass", reasons, findings, read };
}

const ORDER_7 = [
  "lesson_unapproved",
  "lesson_violated",
  "lessons_unreadable",
  "too_many_lessons",
  "lesson_invalid",
  "lesson_approval_unreadable",
  "tree_unreadable",
  "tree_truncated",
  "lesson_read_cap",
  "file_too_large",
  "lesson_file_unreadable",
  "no_lessons",
];

function approvalReads(a: ApprovalRead | null): string[] {
  if (a === null) return [];
  const pages = (r: { endpoint: string; pageEndpoints?: string[] } | null) => (r ? (r.pageEndpoints ?? [r.endpoint]) : []);
  return [a.commits.endpoint, ...pages(a.pulls), ...pages(a.reviews)].map((e) => `GET ${e}`);
}

/** One lesson file's result: approval first, then validity, retirement, and its check. */
function judgeFile(
  f: LessonFileRead,
  identities: readonly AgentIdentity[],
  targets: TargetsRead,
  ref: string,
  read: string[],
): LessonResult {
  const reasons = new ReasonList();
  read.push(...approvalReads(f.approval));
  if (f.blobEndpoint) read.push(`GET ${f.blobEndpoint}`);
  const out: LessonResult = {
    id: f.parsed && "lesson" in f.parsed ? f.parsed.lesson.id : null,
    file: f.path,
    status: "unverifiable",
    reasons: [],
    approvers: [],
    approval: f.approval ? { commit: f.approval.commit, pullRequest: typeof f.approval.pull?.number === "number" ? f.approval.pull.number : null } : null,
    findings: [],
    findingCount: 0,
  };

  let problem: string | null = null;
  if (f.type !== "file") problem = `not a lesson file (a ${f.type})`;
  else if (f.text === null) reasons.add("lessons_unreadable", f.path);
  else if (f.parsed && "problem" in f.parsed) problem = f.parsed.problem;
  if (problem !== null) reasons.add("lesson_invalid", `${f.path}: ${problem}`);

  const approval = f.type === "file" ? judgeApproval(f.approval, identities) : null;
  if (approval?.state === "unapproved") {
    reasons.add("lesson_unapproved", `${f.path}: ${approval.why}`);
    return { ...out, status: "fail", reasons: reasons.list(ORDER_7) };
  }
  if (approval?.state === "unreadable") reasons.add("lesson_approval_unreadable", `${f.path}: ${approval.why}`);
  if (approval?.state === "approved") out.approvers = approval.approvers;
  if (reasons.size > 0 || !f.parsed || !("lesson" in f.parsed)) {
    if (reasons.size === 0) reasons.add("lessons_unreadable", f.path);
    return { ...out, status: "unverifiable", reasons: reasons.list(ORDER_7) };
  }
  const lesson = f.parsed.lesson;
  if (lesson.retired !== undefined) return { ...out, status: "not_in_force" };
  const run = runLesson(lesson, targets, ref);
  read.push(...run.read);
  return {
    ...out,
    status: run.status,
    reasons: run.reasons.list(ORDER_7),
    findings: run.findings.slice(0, MAX_FINDINGS_LISTED),
    findingCount: run.findings.length,
  };
}

export function checkLessonsHold(lessons: LessonsRead | undefined, identities: readonly AgentIdentity[], repoEndpoint: string): CheckRow {
  const fails = new ReasonList();
  const unknowns = new ReasonList();
  const read: string[] = [];
  const context: string[] = [];
  const row = (status: CheckStatus, reasons: Reason[], details?: Record<string, unknown>): CheckRow => {
    const r: CheckRow = { id: "lessons_hold", title: CHECK_TITLES.lessons_hold, status, reasons, read: [...new Set(read)], context };
    if (details !== undefined) r.details = details;
    return r;
  };
  if (lessons === undefined || lessons.state === "not_read") {
    read.push(repoEndpoint);
    unknowns.add("lessons_unreadable", "the default branch's head was not read");
    return row("unverifiable", unknowns.list(ORDER_7));
  }
  read.push(`GET ${lessons.endpoint}`);
  if (lessons.state === "unreadable") {
    unknowns.add("lessons_unreadable", LESSONS_DIR);
    return row("unverifiable", unknowns.list(ORDER_7));
  }
  if (lessons.state === "too_many") {
    unknowns.add("too_many_lessons", `${lessons.count} entries; at most ${MAX_LESSONS} are read`);
    return row("unverifiable", unknowns.list(ORDER_7));
  }

  const results = lessons.files.map((f) => judgeFile(f, identities, lessons.targets, lessons.ref, read));
  for (const r of results) {
    for (const reason of r.reasons) {
      const target = reason.code === "lesson_unapproved" || reason.code === "lesson_violated" ? fails : unknowns;
      target.add(reason.code, ...(reason.subjects ?? []));
    }
  }
  if (identities.length === 0) {
    context.push("No agent identity was declared or detected; approvals by bot accounts and by a pull request's author were still not counted.");
  }
  if (lessons.ref !== lessons.head) {
    context.push(`Lessons were read from the default branch at ${lessons.head.slice(0, 12)} and run over ${lessons.ref.slice(0, 12)}.`);
  }
  const details = { lessonsDirectory: LESSONS_DIR, head: lessons.head, ref: lessons.ref, lessons: results };
  if (fails.size > 0) return row("fail", fails.list(ORDER_7), details);
  if (unknowns.size > 0) return row("unverifiable", unknowns.list(ORDER_7), details);
  if (results.some((r) => r.status === "pass")) return row("pass", [], details);
  const none = new ReasonList().add("no_lessons");
  return row("context", none.list(ORDER_7), details);
}
