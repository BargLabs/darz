// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { globBody } from "./glob.js";
/** GitHub uses the first of these it finds. */
export const CODEOWNERS_LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
export function selectCodeownersFile(present) {
    const set = new Set(present);
    return CODEOWNERS_LOCATIONS.find((p) => set.has(p)) ?? null;
}
/**
 * CODEOWNERS patterns follow gitignore syntax with GitHub's documented
 * differences: always relative to the repository root, case sensitive, and a
 * pattern whose last segment has a `*` matches files only, not the contents
 * of directories it names (`docs/*` does not own `docs/a/b.md`).
 */
export function codeownersRegex(pattern) {
    let p = pattern;
    let anchored = false;
    let dirOnly = false;
    if (p.startsWith("/")) {
        anchored = true;
        p = p.slice(1);
    }
    if (p.endsWith("/")) {
        dirOnly = true;
        p = p.replace(/\/+$/, "");
    }
    if (p.includes("/"))
        anchored = true;
    if (p === "")
        return /^.*$/;
    const prefix = anchored ? "^" : "^(?:.*/)?";
    const last = p.slice(p.lastIndexOf("/") + 1);
    let suffix;
    if (dirOnly)
        suffix = "/.*$";
    else if (last.includes("*"))
        suffix = "$";
    else
        suffix = "(?:/.*)?$";
    return new RegExp(prefix + globBody(p) + suffix);
}
export function codeownersPatternMatches(pattern, path) {
    return codeownersRegex(pattern).test(path);
}
/**
 * GitHub's error kinds whose handling was verified on 24 Nov 2026 in a scratch
 * repository (codeowners/errors, the file view, and the code-owner review
 * GitHub requested on pull requests):
 * - Unknown owner (no such account, or no write access): the line applies
 *   with the owners not flagged, so with all flagged the path has no owner;
 * - Invalid owner, anywhere on the line: the whole line is skipped;
 * - Invalid pattern: the line matches nothing, the same as skipped.
 */
const UNKNOWN_OWNER = "Unknown owner";
const SKIPPING_KINDS = new Set(["Invalid owner", "Invalid pattern"]);
const VERIFIED_KINDS = new Set([UNKNOWN_OWNER, ...SKIPPING_KINDS]);
export function parseCodeowners(text, errors = []) {
    const byLine = new Map();
    for (const e of errors) {
        const ref = typeof e === "number" ? { line: e } : e;
        const list = byLine.get(ref.line) ?? [];
        list.push(ref);
        byLine.set(ref.line, list);
    }
    const rules = [];
    const ignoredLines = [];
    const lines = text.split("\n");
    lines.forEach((rawLine, i) => {
        const lineNo = i + 1;
        const raw = rawLine.replace(/\r$/, "");
        const line = raw.trim();
        if (line === "" || line.startsWith("#"))
            return;
        // Tokens with their 1-based column in the line as written, as GitHub counts.
        const tokens = [...raw.matchAll(/\S+/g)].map((m) => ({ text: m[0], column: (m.index ?? 0) + 1 }));
        const pattern = tokens[0].text;
        // GitHub does not support negation: it reports no error for a ! line, and
        // the line has no effect (verified 24 Nov 2026).
        if (pattern.startsWith("!"))
            return;
        const ownerTokens = [];
        for (const t of tokens.slice(1)) {
            if (t.text.startsWith("#"))
                break;
            ownerTokens.push(t);
        }
        const owners = ownerTokens.map((t) => t.text);
        const lineErrors = byLine.get(lineNo);
        if (!lineErrors) {
            rules.push({ line: lineNo, pattern, owners, errored: false, regex: codeownersRegex(pattern) });
            return;
        }
        ignoredLines.push({ line: lineNo, source: line });
        const kinds = lineErrors.map((e) => e.kind);
        // An Invalid owner or Invalid pattern skips the line, whatever else is on it,
        // as long as every error on it is of a verified kind.
        if (kinds.every((k) => k !== undefined && VERIFIED_KINDS.has(k)) && kinds.some((k) => k !== undefined && SKIPPING_KINDS.has(k))) {
            return;
        }
        // Only Unknown owner errors, each pointing at an owner: the line applies with the others.
        const columns = new Set(ownerTokens.map((t) => t.column));
        if (lineErrors.every((e) => e.kind === UNKNOWN_OWNER && typeof e.column === "number" && columns.has(e.column))) {
            const flagged = new Set(lineErrors.map((e) => e.column));
            const kept = ownerTokens.filter((t) => !flagged.has(t.column)).map((t) => t.text);
            rules.push({ line: lineNo, pattern, owners: kept, errored: false, regex: codeownersRegex(pattern) });
            return;
        }
        // Any other shape is not verified: ambiguous.
        const errorColumns = new Set(lineErrors.map((e) => e.column));
        const unflaggedOwners = errorColumns.has(undefined)
            ? owners
            : ownerTokens.filter((t) => !errorColumns.has(t.column)).map((t) => t.text);
        rules.push({ line: lineNo, pattern, owners, errored: true, unflaggedOwners, regex: codeownersRegex(pattern) });
    });
    return { rules, ignoredLines };
}
export function ownersOf(file, path) {
    for (let i = file.rules.length - 1; i >= 0; i--) {
        const rule = file.rules[i];
        if (!rule.regex.test(path))
            continue;
        if (!rule.errored)
            return { owners: [...rule.owners], line: rule.line, ambiguous: false };
        // Reading one: GitHub applies the line with the owners it did not flag.
        if ((rule.unflaggedOwners ?? []).length > 0)
            return { owners: [], line: rule.line, ambiguous: true };
        // Reading two: GitHub ignores the line, and the last earlier match applies.
        // That match may itself be errored, so it is read the same way.
        const before = { ...file, rules: file.rules.slice(0, i) };
        const earlier = ownersOf(before, path);
        return { owners: [], line: rule.line, ambiguous: earlier.owners.length > 0 || earlier.ambiguous };
    }
    return { owners: [], line: null, ambiguous: false };
}
export function ownerKind(owner) {
    if (!owner.startsWith("@"))
        return "email";
    return owner.includes("/") ? "team" : "user";
}
