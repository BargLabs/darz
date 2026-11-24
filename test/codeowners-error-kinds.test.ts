// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// GitHub's handling of each CODEOWNERS error kind, verified on 24 Nov 2026 in
// a private scratch repository whose line 2 was `* @<a real owner>`. Three
// sources agreed wherever more than one was read: codeowners/errors, the line
// the file view says applies to each path, and the code-owner review GitHub
// requested on a pull request touching one path.
//
//   Unknown owner (no such account, or no write access): the line applies
//     with the owners that were not flagged; with none left, the path has no
//     owner. GitHub does not fall back to an earlier line.
//   Invalid owner, anywhere on the line, even beside a valid owner: the whole
//     line is skipped and an earlier line applies.
//   Invalid pattern: the line matches nothing; an earlier line applies.
//   A `!` negation line: GitHub reports no error and the line has no effect.
//   codeowners/errors lists each flagged owner with its own column.
//
// Lines below mirror the scratch repository's, with its owner renamed @alice.

import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { type CodeownersErrorRef, ownersOf, parseCodeowners } from "../src/codeowners.js";
import { REPO, fileBody, fixtureFetch, goodFixture, ok } from "./fixtures/github.js";

const NO_ONE = "@darz-probe-no-such-user-zz9q";
const NO_ONE_2 = "@darz-probe-no-such-user-zz8q";

const FILE = [
  "# probe",
  "* @alice",
  `/probe/ ${NO_ONE}`,
  `/partial/ @alice ${NO_ONE}`,
  "/noaccess/ @octocat",
  "/invalid/[ab].txt @bob",
  "!/negate/a.txt @bob",
  "/badowner/ not-an-owner",
  "/badmixed/ @bob not-an-owner",
  "/badfirst/ not-an-owner @bob",
  `/twounknown/ ${NO_ONE} ${NO_ONE_2}`,
  `/unknownfirst/ ${NO_ONE} @bob`,
  `/mixedkinds/ @bob ${NO_ONE} not-an-owner`,
  "",
].join("\n");

// The errors GitHub reported for those lines (columns as GitHub gave them,
// adjusted where an owner's name is shorter here).
const ERRORS: CodeownersErrorRef[] = [
  { line: 3, column: 9, kind: "Unknown owner" },
  { line: 4, column: 18, kind: "Unknown owner" },
  { line: 5, column: 12, kind: "Unknown owner" },
  { line: 6, column: 10, kind: "Invalid pattern" },
  { line: 8, column: 12, kind: "Invalid owner" },
  { line: 9, column: 17, kind: "Invalid owner" },
  { line: 10, column: 12, kind: "Invalid owner" },
  { line: 11, column: 14, kind: "Unknown owner" },
  { line: 11, column: 44, kind: "Unknown owner" },
  { line: 12, column: 16, kind: "Unknown owner" },
  { line: 13, column: 49, kind: "Invalid owner" },
  { line: 13, column: 19, kind: "Unknown owner" },
];

const file = parseCodeowners(FILE, ERRORS);
const own = (path: string) => ownersOf(file, path);

describe("CODEOWNERS error kinds, as GitHub handles them", () => {
  it("the fixture's columns point at the owners they flag", () => {
    const lines = FILE.split("\n");
    for (const e of ERRORS) {
      if (typeof e === "number" || e.column === undefined) continue;
      const at = (lines[e.line - 1] ?? "").slice(e.column - 1);
      expect(at.startsWith("@") || at.startsWith("not-an-owner") || at.startsWith("[ab]"), `line ${e.line} col ${e.column}: ${at}`).toBe(true);
    }
  });

  it("Unknown owner, every owner flagged: the line applies and the path has no owner", () => {
    expect(own("probe/a.txt")).toEqual({ owners: [], line: 3, ambiguous: false });
    expect(own("noaccess/a.txt")).toEqual({ owners: [], line: 5, ambiguous: false });
    expect(own("twounknown/a.txt")).toEqual({ owners: [], line: 11, ambiguous: false });
  });

  it("Unknown owner, some owners flagged: the line applies with the others", () => {
    expect(own("partial/a.txt")).toEqual({ owners: ["@alice"], line: 4, ambiguous: false });
    expect(own("unknownfirst/a.txt")).toEqual({ owners: ["@bob"], line: 12, ambiguous: false });
  });

  it("Invalid owner anywhere on the line: the line is skipped, and the earlier line applies", () => {
    for (const d of ["badowner", "badmixed", "badfirst", "mixedkinds"]) {
      expect(own(`${d}/a.txt`), d).toEqual({ owners: ["@alice"], line: 2, ambiguous: false });
    }
  });

  it("Invalid pattern: the line matches nothing, and the earlier line applies", () => {
    expect(own("invalid/[ab].txt")).toEqual({ owners: ["@alice"], line: 2, ambiguous: false });
    expect(own("invalid/a.txt")).toEqual({ owners: ["@alice"], line: 2, ambiguous: false });
  });

  it("a ! negation line has no effect, though GitHub reports no error for it", () => {
    expect(own("negate/a.txt")).toEqual({ owners: ["@alice"], line: 2, ambiguous: false });
    expect(ownersOf(parseCodeowners("* @alice\n!*.md @bob\n"), "!x.md")).toEqual({ owners: ["@alice"], line: 1, ambiguous: false });
  });

  it("every reported line is still listed, the skipped ones included", () => {
    expect(file.ignoredLines.map((l) => l.line)).toEqual([3, 4, 5, 6, 8, 9, 10, 11, 12, 13]);
  });

  it("a valid owner on a skipped line is not a detected owner of its paths", () => {
    expect(own("badmixed/a.txt").owners).not.toContain("@bob");
  });
});

describe("cases that stay unverified, and so ambiguous", () => {
  it("an Unknown owner error with no column: which owner it flags is unknown", () => {
    const f = parseCodeowners(`* @alice\n/x/ @bob ${NO_ONE}\n`, [{ line: 2, kind: "Unknown owner" }]);
    expect(ownersOf(f, "x/a")).toEqual({ owners: [], line: 2, ambiguous: true });
  });

  it("an Unknown owner error whose column points at no owner", () => {
    const f = parseCodeowners(`* @alice\n/x/ @bob ${NO_ONE}\n`, [{ line: 2, column: 2, kind: "Unknown owner" }]);
    expect(ownersOf(f, "x/a").ambiguous).toBe(true);
  });

  it("an error kind GitHub has not been seen to give", () => {
    const f = parseCodeowners("* @alice\n/x/ @bob\n", [{ line: 2, column: 5, kind: "Something new" }]);
    expect(ownersOf(f, "x/a").ambiguous).toBe(true);
  });

  it("an Invalid owner beside an error kind that is not verified", () => {
    const f = parseCodeowners("* @alice\n/x/ @bob nope\n", [
      { line: 2, column: 10, kind: "Invalid owner" },
      { line: 2, column: 5, kind: "Something new" },
    ]);
    expect(ownersOf(f, "x/a").ambiguous).toBe(true);
  });

  it("a bare line number, with no kind", () => {
    const f = parseCodeowners("* @alice\n/x/ @bob\n", [2]);
    expect(ownersOf(f, "x/a").ambiguous).toBe(true);
  });
});

describe("check 1 with an Invalid owner line over an owning line", () => {
  it("passes: GitHub skips the line, so the earlier owner owns the gate file", async () => {
    const fx = goodFixture();
    const text = "* @alice\n/.github/workflows/ @alice not-an-owner\n";
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", text)) };
    fx.codeownersErrors = ok({
      errors: [{ line: 2, column: 28, kind: "Invalid owner", source: "/.github/workflows/ @alice not-an-owner\n", path: ".github/CODEOWNERS" }],
    });
    const a = await assess({ repo: REPO, fetch: fixtureFetch(fx).fetch, agents: ["coder-agent"], now: () => new Date("2026-11-24T12:00:00Z") });
    const r = a.checks.find((c) => c.id === "gate_files_owned");
    expect(r?.reasons.map((x) => x.code) ?? []).not.toContain("codeowners_error_ambiguous");
    expect(r?.status).toBe("pass");
  });
});
