// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// The candidate read was capped at 200 files, so checks 1 and 3 were
// unverifiable for every larger repository. Now: candidates under
// node_modules are not read, files with the same content are read once, and
// the cap is 500 distinct files.

import { describe, expect, it } from "vitest";
import { type Assessment, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import { MAX_CANDIDATE_READS, isCandidatePath } from "../src/gates.js";
import { type Fixture, REPO, SHA, b64, blobSha, fileBody, fixtureFetch, goodFixture, ok, tree } from "./fixtures/github.js";

const OWN_GITHUB_ONLY = "/.github/ @alice\n/vitest.config.ts @alice\n";
const R = `/repos/${REPO}`;

async function run(fx: Fixture): Promise<{ a: Assessment; blobCalls: string[] }> {
  const f = fixtureFetch(fx);
  const a = await assess({ repo: REPO, fetch: f.fetch, agents: ["coder-agent"], now: () => new Date("2026-11-23T12:00:00Z") });
  return { a, blobCalls: f.calls.map((c) => c.url).filter((u) => u.includes("/git/blobs/")) };
}

function row(a: Assessment, id: string): CheckRow {
  return a.checks.find((c) => c.id === id) as CheckRow;
}

/** A fixture whose tree holds `entries` (path and blob key); each blob key's text is served once. */
function sharedBlobFixture(entries: Array<[string, string]>, blobs: Record<string, string>): Fixture {
  const fx = goodFixture();
  const base = [".github/CODEOWNERS", ".github/workflows/ci.yml", "src/index.ts"];
  fx.tree = ok({
    sha: SHA,
    tree: [
      ...base.map((path) => ({ path, mode: "100644", type: "blob", sha: blobSha(path) })),
      ...entries.map(([path, key]) => ({ path, mode: "100644", type: "blob", sha: blobSha(key) })),
    ],
    truncated: false,
  });
  fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", OWN_GITHUB_ONLY)) };
  for (const [key, text] of Object.entries(blobs)) {
    fx.extra[`${R}/git/blobs/${blobSha(key)}`] = ok({ sha: blobSha(key), encoding: "base64", content: b64(text) });
  }
  return fx;
}

function packages(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < n; i++) files[`packages/p${i}/package.json`] = JSON.stringify({ name: `p${i}` });
  return files;
}

function candidateFixture(files: Record<string, string>): Fixture {
  const fx = goodFixture();
  fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml", "src/index.ts", ...Object.keys(files)]);
  fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", OWN_GITHUB_ONLY)) };
  fx.blobs = { ...files };
  return fx;
}

describe("candidate reads in large repositories", () => {
  it("the cap is 500 distinct files", () => {
    expect(MAX_CANDIDATE_READS).toBe(500);
  });

  it("201 candidates are read and judged, no longer over the cap", async () => {
    const { a, blobCalls } = await run(candidateFixture(packages(201)));
    const r = row(a, "gate_files_owned");
    expect(r.status).toBe("pass");
    expect((r.details?.candidatesWithoutTestSettings as string[]).length).toBe(201);
    expect(blobCalls.length).toBe(201);
  });

  it("500 distinct candidates are read; 501 are over the cap and none is read", async () => {
    expect(row((await run(candidateFixture(packages(500)))).a, "gate_files_owned").status).toBe("pass");
    const { a, blobCalls } = await run(candidateFixture(packages(501)));
    const r = row(a, "gate_files_owned");
    expect(r.status).toBe("unverifiable");
    expect(r.reasons.map((x) => x.code)).toEqual(["gate_candidates_over_cap"]);
    expect(r.reasons[0]?.subjects).toEqual(["501 candidate files, 501 distinct; at most 500 distinct files are read"]);
    expect(blobCalls).toEqual([]);
  });

  it("files with the same content are read once, and each path is still judged", async () => {
    const entries: Array<[string, string]> = [];
    for (let i = 0; i < 1000; i++) entries.push([`packages/p${i}/package.json`, i % 2 === 0 ? "plain" : "tested"]);
    const fx = sharedBlobFixture(entries, {
      plain: JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
      tested: JSON.stringify({ name: "x", scripts: { test: "vitest run" } }),
    });
    const { a, blobCalls } = await run(fx);
    expect(blobCalls.length).toBe(2);
    const r = row(a, "gate_files_owned");
    expect(r.status).toBe("fail");
    expect((r.reasons.find((x) => x.code === "gate_files_unowned")?.subjects ?? []).length).toBe(500);
    expect((r.details?.candidatesWithoutTestSettings as string[]).length).toBe(500);
    // The record lists each distinct read once.
    expect(a.reads.filter((e) => e.endpoint.includes("/git/blobs/")).length).toBe(2);
  });

  it("one blob under two candidate names is judged by each name", async () => {
    const json = JSON.stringify({ scripts: { test: "jest" } });
    const fx = sharedBlobFixture(
      [
        ["a/package.json", "same"],
        ["b/setup.cfg", "same"],
      ],
      { same: json },
    );
    const { a, blobCalls } = await run(fx);
    expect(blobCalls.length).toBe(1);
    const r = row(a, "gate_files_owned");
    expect(r.reasons.find((x) => x.code === "gate_files_unowned")?.subjects).toEqual(["a/package.json"]);
    expect(r.details?.candidatesWithoutTestSettings).toEqual(["b/setup.cfg"]);
  });

  it("candidates under a node_modules directory are not candidates", () => {
    expect(isCandidatePath("node_modules/left-pad/package.json")).toBe(false);
    expect(isCandidatePath("packages/a/node_modules/x/package.json")).toBe(false);
    expect(isCandidatePath("node_modules/node-gyp/gyp/pyproject.toml")).toBe(false);
    expect(isCandidatePath("src/node_modules_helpers/package.json")).toBe(true);
    expect(isCandidatePath("packages/a/package.json")).toBe(true);
  });

  it("a committed node_modules adds no reads and does not count toward the cap", async () => {
    const files = packages(10);
    const fx = candidateFixture(files);
    const vendored: string[] = [];
    for (let i = 0; i < 600; i++) vendored.push(`node_modules/dep${i}/package.json`);
    fx.tree = tree([".github/CODEOWNERS", ".github/workflows/ci.yml", ...Object.keys(files), ...vendored]);
    const { a, blobCalls } = await run(fx);
    const r = row(a, "gate_files_owned");
    expect(r.status).toBe("pass");
    expect(blobCalls.length).toBe(10);
  });
});
