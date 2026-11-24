// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// What ships in this repository is public. Its comments, test names and docs
// explain each behaviour in their own words. They do not point at an issue or
// pull request number on a tracker a reader may not see, and they carry no
// local paths or personal email addresses.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoFiles, root } from "./helpers/tree.js";

// Whole files are matched, not single lines, so a reference that wraps onto
// the next comment line is still found. GAP is the space between two words,
// across a line break and the next line's comment marker if there is one.
const GAP = String.raw`(?:[ \t]|\r?\n[ \t]*(?:\/\/|\*|#)?[ \t]*)+`;

const ISSUE_REFS = [
  // "issue N", "PR#N", "PRs N and N", "pull request N", and the same wrapped onto the next line
  new RegExp(String.raw`\b(?:issues?|PRs?|pull${GAP}requests?)(?:${GAP}|(?:${GAP})?#)\d+\b`, "gi"),
  // a bare "#N" after a space or bracket ("see #N", "(#N)"); a quoted one is fixture data
  /(?<=^|[\s([])#\d+\b/gm,
  /\bGH-\d+\b/g,
  /github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+/gi,
];
const HOME_PATH = /\/(?:Users|home)\/[A-Za-z0-9._-]+/g;
// The lookbehind skips the password in a URL's user:password@host.
const EMAIL = /(?<![:A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A noreply address (any domain), or a reserved example domain.
const EMAIL_ALLOWED = /^[^@]*no-?reply[^@]*@|@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|noreply\.github\.com)$/i;

const files = repoFiles();
const texts = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));

function find(text: string, pattern: RegExp, allow: (m: string) => boolean = () => false): { line: number; match: string }[] {
  return [...text.matchAll(pattern)]
    .filter((m) => !allow(m[0]))
    .map((m) => ({ line: text.slice(0, m.index).split("\n").length, match: m[0] }));
}

function hits(patterns: RegExp[], allow?: (m: string) => boolean): string[] {
  const found: string[] = [];
  for (const [f, text] of texts) {
    for (const p of patterns) for (const h of find(text, p, allow)) found.push(`${f}:${h.line}: ${JSON.stringify(h.match)}`);
  }
  return found;
}

const caught = (patterns: RegExp[], sample: string, allow?: (m: string) => boolean) =>
  patterns.some((p) => find(sample, p, allow).length > 0);

describe("public boundary", () => {
  it("no comment, test name or doc cites an issue or pull request by number", () => {
    expect(hits(ISSUE_REFS)).toEqual([]);
  });

  it("no local home-directory path", () => {
    expect(hits([HOME_PATH])).toEqual([]);
  });

  it("no email address other than noreply and example ones", () => {
    expect(hits([EMAIL], (m) => EMAIL_ALLOWED.test(m))).toEqual([]);
  });

  it("the scan reads every file that ships, root files included", () => {
    for (const f of ["src/assess.ts", "test/public-boundary.test.ts", "docs/checks.md", "dist/bin.js", "action.yml", "LICENSE", "tsconfig.json", ".gitignore"]) {
      expect(files).toContain(f);
      expect(texts.get(f)?.length).toBeGreaterThan(0);
    }
  });

  // Each sample is assembled at run time so this file does not trip its own scan.
  it("each pattern catches what it exists to catch", () => {
    const n = (s: string) => s.replace(/N/g, "4");
    for (const s of ["issue N", "Issue N:", "PRs N and N", "PR#N", "PR #N", "pull request N", "see #N", "closes #N", "(#N)", "GH-N",
      "https://github.com/o/r/issues/N", "https://github.com/o/r/pull/N", "// the two disagree (issue\n// N).", " * see issue\n * N", "# PR\n# #N"]) {
      expect(caught(ISSUE_REFS, n(s)), s).toBe(true);
    }
    for (const s of ['subject "#N"', "the tool issues the call", "#Nfff", "&#N;"]) {
      expect(caught(ISSUE_REFS, n(s)), s).toBe(false);
    }
    expect(caught([HOME_PATH], "/" + "Users/someone/x")).toBe(true);
    expect(caught([HOME_PATH], "/" + "home/someone/x")).toBe(true);
    const email = (s: string) => caught([EMAIL], s, (m) => EMAIL_ALLOWED.test(m));
    expect(email("dev" + "@" + "corp.io")).toBe(true);
    expect(email("someone" + "@" + "api.github.com")).toBe(true);
    expect(email("noreply" + "@" + "anthropic.com")).toBe(false);
    expect(email("https://user:pw" + "@" + "api.github.com")).toBe(false);
    expect(email("1+bot" + "@" + "users.noreply.github.com")).toBe(false);
    expect(email("a" + "@" + "example.com")).toBe(false);
  });
});
