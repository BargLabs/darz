// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
/**
 * Lessons: rules a team has learnt, kept as files in the repository and run
 * as deterministic checks. A lesson is one JSON object per file at
 * `.github/darz/lessons/<id>.json` (schema/lesson-0.1.schema.json).
 * {@link parseLesson} is the validator Darz runs; it mirrors the schema, and
 * also checks what a schema cannot: that the id is the file name, and that a
 * regex pattern compiles.
 */
export const LESSONS_DIR = ".github/darz/lessons";
/** Lessons Darz reads in one run; more makes check 7 unverifiable. */
export const MAX_LESSONS = 100;
/** Distinct files (blobs) Darz reads across all lessons in one run. */
export const MAX_LESSON_FILE_READS = 3000;
/** A file larger than this is not scanned: the lesson is unverifiable. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** A line longer than this (in UTF-16 code units) is not scanned: the lesson is unverifiable. */
export const MAX_LINE_CHARS = 4096;
const ID = /^[a-z0-9-]{3,64}$/;
const FILE_NAME = /^([a-z0-9-]{3,64})\.json$/;
const EVIDENCE_REF = {
    commit: /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/,
    pull_request: /^[1-9][0-9]{0,9}$/,
    issue: /^[1-9][0-9]{0,9}$/,
    url: /^https:\/\/\S+$/,
};
const MAX_STATEMENT = 500;
const MAX_EVIDENCE = 20;
const MAX_URL = 2000;
const MAX_PATHS = 50;
const MAX_PATH = 500;
const MAX_PATTERN = 1000;
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s) => !/[\r\n]/.test(s);
function onlyKeys(o, allowed, where) {
    const extra = Object.keys(o).find((k) => !allowed.includes(k));
    return extra === undefined ? null : `${where} has an unknown key "${extra}"`;
}
function isDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m)
        return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.toISOString().slice(0, 10) === s;
}
/** Compile a lesson's pattern into a per-line test. Throws if a regex does not compile. */
export function lineMatcher(check) {
    if (check.match === "literal")
        return (line) => line.includes(check.pattern);
    const re = new RegExp(check.pattern, "u");
    return (line) => re.test(line);
}
/**
 * Parse and validate one lesson file. `fileName` is the file's name in the
 * lessons directory. Returns the lesson as written, or the first problem
 * found; a lesson is never repaired or partly accepted.
 */
export function parseLesson(text, fileName) {
    const name = FILE_NAME.exec(fileName);
    if (!name)
        return { problem: "the file name is not <id>.json, with an id of 3 to 64 of a-z, 0-9 and -" };
    let raw;
    try {
        raw = JSON.parse(text.replace(/^﻿/, ""));
    }
    catch {
        return { problem: "not valid JSON" };
    }
    if (!isObject(raw))
        return { problem: "not a JSON object" };
    const top = onlyKeys(raw, ["id", "statement", "evidence", "check", "retired"], "the lesson");
    if (top)
        return { problem: top };
    const { id, statement, evidence, check, retired } = raw;
    if (typeof id !== "string" || !ID.test(id))
        return { problem: '"id" must be 3 to 64 of a-z, 0-9 and -' };
    if (id !== name[1])
        return { problem: `"id" is "${id}" but the file name is ${fileName}` };
    if (typeof statement !== "string" || statement.length === 0 || statement.length > MAX_STATEMENT || !oneLine(statement)) {
        return { problem: `"statement" must be one line of 1 to ${MAX_STATEMENT} characters` };
    }
    if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > MAX_EVIDENCE) {
        return { problem: `"evidence" must list 1 to ${MAX_EVIDENCE} items` };
    }
    for (const e of evidence) {
        if (!isObject(e))
            return { problem: '"evidence" items must be objects' };
        const k = onlyKeys(e, ["kind", "ref"], "an evidence item");
        if (k)
            return { problem: k };
        if (typeof e.kind !== "string" || !(e.kind in EVIDENCE_REF)) {
            return { problem: 'evidence "kind" must be commit, pull_request, issue or url' };
        }
        const ref = e.ref;
        if (typeof ref !== "string" || !EVIDENCE_REF[e.kind].test(ref) || ref.length > MAX_URL) {
            return {
                problem: `evidence "ref" for ${e.kind} must be ${e.kind === "commit" ? "a full commit SHA" : e.kind === "url" ? "an https URL" : "a number"}`,
            };
        }
    }
    if (!isObject(check))
        return { problem: '"check" must be an object' };
    const ck = onlyKeys(check, ["kind", "paths", "pattern", "match"], '"check"');
    if (ck)
        return { problem: ck };
    if (check.kind !== "forbid" && check.kind !== "require")
        return { problem: 'check "kind" must be forbid or require' };
    if (!Array.isArray(check.paths) ||
        check.paths.length === 0 ||
        check.paths.length > MAX_PATHS ||
        !check.paths.every((p) => typeof p === "string" && p.length > 0 && p.length <= MAX_PATH && oneLine(p))) {
        return { problem: `check "paths" must list 1 to ${MAX_PATHS} globs` };
    }
    if (typeof check.pattern !== "string" || check.pattern.length === 0 || check.pattern.length > MAX_PATTERN) {
        return { problem: `check "pattern" must be 1 to ${MAX_PATTERN} characters` };
    }
    if (check.match !== "literal" && check.match !== "regex")
        return { problem: 'check "match" must be literal or regex' };
    if (check.match === "regex") {
        try {
            new RegExp(check.pattern, "u");
        }
        catch {
            return { problem: 'check "pattern" is not a regular expression that compiles with the u flag' };
        }
    }
    if (retired !== undefined) {
        if (!isObject(retired))
            return { problem: '"retired" must be an object' };
        const rk = onlyKeys(retired, ["on", "reason"], '"retired"');
        if (rk)
            return { problem: rk };
        if (typeof retired.on !== "string" || !isDate(retired.on))
            return { problem: 'retired "on" must be a date, YYYY-MM-DD' };
        if (typeof retired.reason !== "string" || retired.reason.length === 0 || retired.reason.length > MAX_STATEMENT) {
            return { problem: `retired "reason" must be 1 to ${MAX_STATEMENT} characters` };
        }
    }
    return { lesson: raw };
}
/**
 * The 1-based numbers of the lines that match, or `too_large` when a line is
 * longer than {@link MAX_LINE_CHARS}. Lines end at `\n`; a `\r` before it is
 * not part of the line.
 */
export function scanText(text, matches) {
    const lines = text.split("\n");
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, "");
        if (line.length > MAX_LINE_CHARS)
            return { state: "too_large", why: `line ${i + 1} is over ${MAX_LINE_CHARS} characters` };
        if (matches(line))
            hits.push(i + 1);
    }
    return { state: "scanned", lines: hits };
}
