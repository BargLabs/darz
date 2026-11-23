// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REASONS } from "../src/checks/reasons.js";
import { CHECK_IDS } from "../src/checks/types.js";
import { TOOL_VERSION } from "../src/version.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("docs/checks.md", () => {
  const doc = read("docs/checks.md");
  it("documents every reason code the checks can give", () => {
    const missing = Object.keys(REASONS).filter((code) => !doc.includes(`\`${code}\``));
    expect(missing).toEqual([]);
  });
  it("has a section per check", () => {
    for (const id of CHECK_IDS) expect(doc).toContain(`## ${CHECK_IDS.indexOf(id) + 1}. \`${id}\``);
  });
});

describe("README", () => {
  const readme = read("README.md");
  it("documents the exit codes", () => {
    for (const code of ["`0`", "`1`", "`2`", "`3`"]) expect(readme).toContain(code);
  });
  it("says what unverifiable means and that some settings need administration read", () => {
    expect(readme).toMatch(/unverifiable/);
    expect(readme).toMatch(/administration/);
  });
  it("keeps the Built by Barg Labs line", () => {
    expect(readme).toContain("Built by [Barg Labs](https://barglabs.ai).");
  });
});

describe("package", () => {
  const pkg = JSON.parse(read("package.json"));
  it("stays private, Apache-2.0, with no runtime dependencies", () => {
    expect(pkg.private).toBe(true);
    expect(pkg.license).toBe("Apache-2.0");
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
    expect(pkg.version).toBe(TOOL_VERSION);
  });
  it("every source and test file carries an Apache-2.0 SPDX header", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(join(root, d))) {
        const p = join(d, f);
        if (statSync(join(root, p)).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk("src");
    walk("test");
    const without = files.filter((f) => !read(f).split("\n").slice(0, 3).includes("// SPDX-License-Identifier: Apache-2.0"));
    expect(without).toEqual([]);
  });
});

describe("CI", () => {
  const ci = read(".github/workflows/ci.yml");
  it("pins every action by full commit SHA", () => {
    const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1] as string);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });
  it("reads contents only and has one job named test", () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(ci).toMatch(/^jobs:\n {2}test:$/m);
    const jobs = ci.slice(ci.indexOf("\njobs:\n"));
    expect([...jobs.matchAll(/^ {2}[a-z][\w-]*:$/gm)].map((m) => m[0].trim())).toEqual(["test:"]);
  });
});
