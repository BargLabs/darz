// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { CODEOWNERS_LOCATIONS } from "./codeowners.js";
import { globBody } from "./glob.js";

/**
 * The files that judge an agent's work: CI and actions, test configuration
 * and coverage configuration. The CODEOWNERS file in use is added by the
 * caller, as is Darz's own configuration file.
 */
export const DEFAULT_GATE_PATTERNS: readonly string[] = [
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
];

export const DARZ_CONFIG_PATH = ".github/darz.json";

const cache = new Map<string, RegExp>();

/** An anchored path glob: the whole path must match. */
export function globMatches(glob: string, path: string): boolean {
  let re = cache.get(glob);
  if (!re) {
    re = new RegExp(`^${globBody(glob.replace(/^\/+/, ""))}$`);
    cache.set(glob, re);
  }
  return re.test(path);
}

export interface GateSet {
  patterns: string[];
  /** Exact paths that are always gate files: the CODEOWNERS file in use and the Darz config. */
  exact: string[];
}

/**
 * Files that are gate files only when they hold test or coverage settings.
 * Counting every package.json would make every dependency bump a gate change;
 * Darz reads each candidate and counts it only if it configures tests.
 */
export const CANDIDATE_GATE_PATTERNS: readonly string[] = [
  "**/package.json",
  "**/vite.config.*",
  "**/pyproject.toml",
  "**/setup.cfg",
];

/** Darz reads at most this many candidates; more makes the inventory incomplete. */
export const MAX_CANDIDATE_READS = 200;

export function isCandidatePath(path: string): boolean {
  return CANDIDATE_GATE_PATTERNS.some((g) => globMatches(g, path));
}

const PACKAGE_TEST_KEYS = ["jest", "nyc", "c8", "vitest", "mocha", "ava", "tap"];

/**
 * Does this candidate hold test or coverage settings? `null` when it cannot be
 * parsed, which leaves the inventory incomplete rather than deciding either way.
 * - package.json: a script named test or coverage (test:unit, coverage-ci, ...),
 *   or a jest, nyc, c8, vitest, mocha, ava or tap block;
 * - vite.config.*: a `test:` key (Vitest's inline configuration);
 * - pyproject.toml: a [tool.pytest...] or [tool.coverage...] table;
 * - setup.cfg: a [tool:pytest] or [coverage:...] section.
 */
export function holdsTestSettings(path: string, text: string): boolean | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "package.json") {
    let pkg: unknown;
    try {
      pkg = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return null;
    const p = pkg as Record<string, unknown>;
    if (PACKAGE_TEST_KEYS.some((k) => k in p)) return true;
    const scripts = p.scripts;
    if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
      return Object.keys(scripts).some((k) => /^(test|coverage)([:._-]|$)/i.test(k));
    }
    return false;
  }
  if (name.startsWith("vite.config.")) return /(^|[\s{,])test\s*:/m.test(text);
  if (name === "pyproject.toml") return /^\s*\[\s*tool\.(pytest|coverage)(\.|\s*\])/m.test(text);
  if (name === "setup.cfg") return /^\s*\[(tool:pytest|coverage:[^\]]+)\]/m.test(text);
  return false;
}

export function gateSet(
  extraGlobs: readonly string[],
  codeownersInUse: string | null,
  candidateGates: readonly string[] = [],
): GateSet {
  const patterns = [...new Set([...DEFAULT_GATE_PATTERNS, ...extraGlobs])];
  const exact = [DARZ_CONFIG_PATH, ...candidateGates];
  if (codeownersInUse) exact.push(codeownersInUse);
  return { patterns, exact };
}

export function isGatePath(set: GateSet, path: string): boolean {
  return set.exact.includes(path) || set.patterns.some((g) => globMatches(g, path));
}

/**
 * For pull request file lists: any of GitHub's CODEOWNERS locations counts,
 * since adding a higher-precedence CODEOWNERS file changes ownership.
 */
export function isGatePathForChange(set: GateSet, path: string): boolean {
  return isGatePath(set, path) || CODEOWNERS_LOCATIONS.includes(path);
}

export function gateFilesIn(set: GateSet, paths: readonly string[]): string[] {
  return [...new Set(paths.filter((p) => isGatePath(set, p)))].sort();
}
