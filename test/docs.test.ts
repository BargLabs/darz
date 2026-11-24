// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REASONS } from "../src/checks/reasons.js";
import { CHECK_IDS } from "../src/checks/types.js";
import { TOOL_VERSION } from "../src/version.js";
import { repoFiles } from "./helpers/tree.js";

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
    const files = repoFiles().filter((f) => /^(?:src|test)\//.test(f) && f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const without = files.filter((f) => !read(f).split("\n").slice(0, 3).includes("// SPDX-License-Identifier: Apache-2.0"));
    expect(without).toEqual([]);
  });
});

describe("action name", () => {
  it("action.yml and the README give the same Marketplace name", () => {
    const name = /^name:\s*(.+?)\s*$/m.exec(read("action.yml"))?.[1];
    expect(name).toBe("DARZ Agent Gate Check");
    expect(read("README.md")).toContain(`listed on the Marketplace as **${name}**`);
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

  // A matrix would report its legs as "test (22)" and "test (24)",
  // and a ruleset that requires the check "test" would never see it. So the
  // one job runs every Node version in sequence.
  const nodeVersions = [...ci.matchAll(/^\s*node-version:\s*"?(\d+)"?\s*$/gm)].map((m) => Number(m[1]));
  it("has no matrix, so the check stays named test", () => {
    expect(ci).not.toMatch(/^\s*(strategy|matrix):/m);
  });
  it("tests the lowest Node major that package.json's engines claims", () => {
    const engines = JSON.parse(read("package.json")).engines?.node as string;
    const floor = /^>=(\d+)(\.\d+){0,2}$/.exec(engines);
    expect(floor, `engines.node ${engines}`).not.toBeNull();
    expect(nodeVersions).toContain(Number(floor?.[1]));
    expect(read("README.md")).toContain(`You need Node ${floor?.[1]} or later`);
  });
  it("tests the Node major the Action runs on", () => {
    const using = /^ {2}using:\s*node(\d+)\s*$/m.exec(read("action.yml"));
    expect(using).not.toBeNull();
    expect(nodeVersions).toContain(Number(using?.[1]));
  });
});
