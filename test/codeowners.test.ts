// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { describe, expect, it } from "vitest";
import {
  CODEOWNERS_LOCATIONS,
  codeownersPatternMatches,
  ownersOf,
  parseCodeowners,
  selectCodeownersFile,
} from "../src/codeowners.js";
import { DEFAULT_GATE_PATTERNS, globMatches } from "../src/gates.js";

describe("which CODEOWNERS file GitHub uses", () => {
  it("searches .github/CODEOWNERS, then CODEOWNERS, then docs/CODEOWNERS", () => {
    expect(CODEOWNERS_LOCATIONS).toEqual([".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]);
  });
  it(".github/CODEOWNERS wins over the root file", () => {
    expect(selectCodeownersFile(["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"])).toBe(".github/CODEOWNERS");
  });
  it("the root file wins over docs/CODEOWNERS", () => {
    expect(selectCodeownersFile(["docs/CODEOWNERS", "CODEOWNERS"])).toBe("CODEOWNERS");
  });
  it("none present gives null", () => {
    expect(selectCodeownersFile(["README.md"])).toBeNull();
  });
});

describe("CODEOWNERS ownership", () => {
  it("the last matching pattern wins", () => {
    const a = parseCodeowners("* @everyone\n/.github/ @gatekeeper\n");
    expect(ownersOf(a, ".github/workflows/ci.yml").owners).toEqual(["@gatekeeper"]);
    const b = parseCodeowners("/.github/ @gatekeeper\n* @everyone\n");
    expect(ownersOf(b, ".github/workflows/ci.yml").owners).toEqual(["@everyone"]);
  });

  it("a pattern with no owners leaves the path unowned", () => {
    const f = parseCodeowners("* @everyone\n/.github/workflows/\n");
    const o = ownersOf(f, ".github/workflows/ci.yml");
    expect(o.owners).toEqual([]);
    expect(o.line).toBe(2);
  });

  it("a line GitHub reports in codeowners/errors gives no owner", () => {
    const f = parseCodeowners("/.github/ @ghost-user\n", [1]);
    const o = ownersOf(f, ".github/workflows/ci.yml");
    expect(o.owners).toEqual([]);
    expect(f.ignoredLines).toEqual([{ line: 1, source: "/.github/ @ghost-user" }]);
  });

  it("an errored last match over an earlier owned match is flagged ambiguous, still with no owner", () => {
    const f = parseCodeowners("* @everyone\n/.github/ @ghost-user\n", [2]);
    const o = ownersOf(f, ".github/workflows/ci.yml");
    expect(o.owners).toEqual([]);
    expect(o.ambiguous).toBe(true);
  });

  it("ignores blank lines, comment lines and trailing comments", () => {
    const f = parseCodeowners("# owners\n\n*.yml @yaml-owner # trailing note\n");
    expect(ownersOf(f, "a/b.yml").owners).toEqual(["@yaml-owner"]);
  });

  it("keeps team and email owners as written", () => {
    const f = parseCodeowners("* @org/gate-team ops@example.com\n");
    expect(ownersOf(f, "x").owners).toEqual(["@org/gate-team", "ops@example.com"]);
  });

  it("an unmatched path has no owner and no line", () => {
    const f = parseCodeowners("/docs/ @writer\n");
    expect(ownersOf(f, "src/a.ts")).toEqual({ owners: [], line: null, ambiguous: false });
  });
});

describe("CODEOWNERS pattern syntax", () => {
  const cases: Array<[string, string, boolean]> = [
    ["*", "a/b/c.txt", true],
    ["*.js", "src/deep/file.js", true],
    ["*.js", "src/deep/file.ts", false],
    ["/build/logs/", "build/logs/a/b.txt", true],
    ["/build/logs/", "x/build/logs/a.txt", false],
    ["apps/", "deep/apps/x.txt", true],
    ["apps/", "apps", false],
    ["docs/*", "docs/getting-started.md", true],
    ["docs/*", "docs/build-app/troubleshooting.md", false],
    ["/docs", "docs/a/b.md", true],
    ["**/logs", "a/b/logs/x.txt", true],
    ["**/logs", "logs/x.txt", true],
    ["/scripts/**", "scripts/a/b.sh", true],
    ["docs/**/x.md", "docs/x.md", true],
    ["docs/**/x.md", "docs/a/b/x.md", true],
    [".github/workflows/", ".github/workflows/ci.yml", true],
    ["CODEOWNERS", ".github/CODEOWNERS", true],
    ["/CODEOWNERS", ".github/CODEOWNERS", false],
    ["a?c", "abc", true],
    ["a?c", "a/c", false],
  ];
  for (const [pattern, path, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${path}`, () => {
      expect(codeownersPatternMatches(pattern, path)).toBe(expected);
    });
  }
  it("is case sensitive", () => {
    expect(codeownersPatternMatches("/Docs/", "docs/a.md")).toBe(false);
  });
});

describe("gate globs", () => {
  const cases: Array<[string, string, boolean]> = [
    [".github/workflows/**", ".github/workflows/ci.yml", true],
    [".github/workflows/**", ".github/workflows/sub/x.yml", true],
    [".github/workflows/**", ".github/workflowsx/ci.yml", false],
    ["**/jest.config.*", "jest.config.js", true],
    ["**/jest.config.*", "packages/a/jest.config.ts", true],
    ["**/jest.config.*", "packages/a/jest.config", false],
    ["**/.mocharc*", ".mocharc.yml", true],
    ["**/phpunit.xml*", "phpunit.xml.dist", true],
    ["**/conftest.py", "tests/unit/conftest.py", true],
    ["**/conftest.py", "tests/unit/myconftest.py", false],
  ];
  for (const [glob, path, expected] of cases) {
    it(`${glob} ${expected ? "matches" : "does not match"} ${path}`, () => {
      expect(globMatches(glob, path)).toBe(expected);
    });
  }
  it("the default patterns cover CI, actions, test configuration and coverage", () => {
    for (const p of [
      ".github/workflows/**",
      ".github/actions/**",
      "**/jest.config.*",
      "**/vitest.config.*",
      "**/vitest.workspace.*",
      "**/playwright.config.*",
      "**/karma.conf.*",
      "**/.mocharc*",
      "**/pytest.ini",
      "**/tox.ini",
      "**/noxfile.py",
      "**/conftest.py",
      "**/phpunit.xml*",
      "**/.nycrc*",
      "**/codecov.yml",
      "**/.codecov.yml",
      "**/.coveragerc",
      "**/sonar-project.properties",
    ]) {
      expect(DEFAULT_GATE_PATTERNS).toContain(p);
    }
  });
});
