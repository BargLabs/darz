// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { globBody } from "./glob.js";

/** GitHub uses the first of these it finds. */
export const CODEOWNERS_LOCATIONS: readonly string[] = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export function selectCodeownersFile(present: Iterable<string>): string | null {
  const set = new Set(present);
  return CODEOWNERS_LOCATIONS.find((p) => set.has(p)) ?? null;
}

export interface CodeownersRule {
  line: number;
  pattern: string;
  owners: string[];
  /**
   * GitHub reported an error on this line and how it handles the line is not
   * verified; its owners do not count. A line whose every owner GitHub reports
   * as unknown is verified (it applies with no owner) and is not errored.
   */
  errored: boolean;
  /**
   * On an errored line, the owners GitHub did not flag by column: if GitHub
   * applies the line with them, they own its paths. Every owner when an error
   * has no column, since then which owner it is about is unknown.
   */
  unflaggedOwners?: string[];
  regex: RegExp;
}

export interface CodeownersFile {
  rules: CodeownersRule[];
  ignoredLines: Array<{ line: number; source: string }>;
}

export interface Ownership {
  owners: string[];
  /** The line of the last matching pattern, or null when nothing matches. */
  line: number | null;
  /**
   * True when the last match is a line GitHub reported as an error, and the
   * path would have an owner under one reading of it: the line applies with
   * its unflagged owners, or it is ignored and an earlier line owns the path.
   * GitHub's handling of such a line is not something Darz can read, so the
   * path is neither owned nor clearly unowned. When both readings leave it
   * with no owner, it is unowned.
   */
  ambiguous: boolean;
}

/**
 * CODEOWNERS patterns follow gitignore syntax with GitHub's documented
 * differences: always relative to the repository root, case sensitive, and a
 * pattern whose last segment has a `*` matches files only, not the contents
 * of directories it names (`docs/*` does not own `docs/a/b.md`).
 */
export function codeownersRegex(pattern: string): RegExp {
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
  if (p.includes("/")) anchored = true;
  if (p === "") return /^.*$/;
  const prefix = anchored ? "^" : "^(?:.*/)?";
  const last = p.slice(p.lastIndexOf("/") + 1);
  let suffix: string;
  if (dirOnly) suffix = "/.*$";
  else if (last.includes("*")) suffix = "$";
  else suffix = "(?:/.*)?$";
  return new RegExp(prefix + globBody(p) + suffix);
}

export function codeownersPatternMatches(pattern: string, path: string): boolean {
  return codeownersRegex(pattern).test(path);
}

/** A line GitHub reports in codeowners/errors: a bare line number, or the error's fields. */
export type CodeownersErrorRef = number | { line: number; column?: number; kind?: string };

/** GitHub's kind for an owner it does not recognise. */
const UNKNOWN_OWNER = "Unknown owner";

export function parseCodeowners(text: string, errors: readonly CodeownersErrorRef[] = []): CodeownersFile {
  const byLine = new Map<number, Array<{ column?: number; kind?: string }>>();
  for (const e of errors) {
    const ref = typeof e === "number" ? { line: e } : e;
    const list = byLine.get(ref.line) ?? [];
    list.push(ref);
    byLine.set(ref.line, list);
  }
  const rules: CodeownersRule[] = [];
  const ignoredLines: Array<{ line: number; source: string }> = [];
  const lines = text.split("\n");
  lines.forEach((rawLine, i) => {
    const lineNo = i + 1;
    const raw = rawLine.replace(/\r$/, "");
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    // Tokens with their 1-based column in the line as written, as GitHub counts.
    const tokens = [...raw.matchAll(/\S+/g)].map((m) => ({ text: m[0], column: (m.index ?? 0) + 1 }));
    const pattern = (tokens[0] as { text: string }).text;
    const ownerTokens: Array<{ text: string; column: number }> = [];
    for (const t of tokens.slice(1)) {
      if (t.text.startsWith("#")) break;
      ownerTokens.push(t);
    }
    const owners = ownerTokens.map((t) => t.text);
    const lineErrors = byLine.get(lineNo);
    if (!lineErrors) {
      rules.push({ line: lineNo, pattern, owners, errored: false, regex: codeownersRegex(pattern) });
      return;
    }
    ignoredLines.push({ line: lineNo, source: line });
    // Verified in a scratch repository: when every owner on a
    // line is reported as an unknown owner, GitHub still applies the line and
    // the path has no code owner. Any other case is not verified: ambiguous.
    const flagged = new Set(
      lineErrors.filter((e) => e.kind === UNKNOWN_OWNER && typeof e.column === "number").map((e) => e.column),
    );
    const allUnknown =
      ownerTokens.length > 0 &&
      lineErrors.every((e) => e.kind === UNKNOWN_OWNER && typeof e.column === "number") &&
      ownerTokens.every((t) => flagged.has(t.column));
    if (allUnknown) {
      rules.push({ line: lineNo, pattern, owners: [], errored: false, regex: codeownersRegex(pattern) });
      return;
    }
    const columns = new Set(lineErrors.map((e) => e.column));
    const unflaggedOwners = columns.has(undefined)
      ? owners
      : ownerTokens.filter((t) => !columns.has(t.column)).map((t) => t.text);
    rules.push({ line: lineNo, pattern, owners, errored: true, unflaggedOwners, regex: codeownersRegex(pattern) });
  });
  return { rules, ignoredLines };
}

export function ownersOf(file: CodeownersFile, path: string): Ownership {
  for (let i = file.rules.length - 1; i >= 0; i--) {
    const rule = file.rules[i] as CodeownersRule;
    if (!rule.regex.test(path)) continue;
    if (!rule.errored) return { owners: [...rule.owners], line: rule.line, ambiguous: false };
    // Reading one: GitHub applies the line with the owners it did not flag.
    if ((rule.unflaggedOwners ?? []).length > 0) return { owners: [], line: rule.line, ambiguous: true };
    // Reading two: GitHub ignores the line, and the last earlier match applies.
    // That match may itself be errored, so it is read the same way.
    const before: CodeownersFile = { ...file, rules: file.rules.slice(0, i) };
    const earlier = ownersOf(before, path);
    return { owners: [], line: rule.line, ambiguous: earlier.owners.length > 0 || earlier.ambiguous };
  }
  return { owners: [], line: null, ambiguous: false };
}

export type OwnerKind = "user" | "team" | "email";

export function ownerKind(owner: string): OwnerKind {
  if (!owner.startsWith("@")) return "email";
  return owner.includes("/") ? "team" : "user";
}
