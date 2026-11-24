// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Verified on 23 Nov 2026 in a scratch repository:
//   line 2: * @alice   (in the probe, a real user with write access)
//   line 3: /probe/ @darz-probe-no-such-user-zz9q   (codeowners/errors: Unknown owner, column 9)
// GitHub showed a code-owner shield for that user on README.md and none on
// probe/a.txt. So a line whose every owner is reported unknown still matches,
// as the last match, and leaves the path with no code owner: GitHub does not
// fall back to the earlier line. The other error kinds, verified on 24 Nov,
// are in codeowners-error-kinds.test.ts.

import { describe, expect, it } from "vitest";
import { ownersOf, parseCodeowners } from "../src/codeowners.js";
import { assess } from "../src/assess.js";
import { REPO, fileBody, fixtureFetch, goodFixture, ok } from "./fixtures/github.js";

const PROBE = "# probe\n* @alice\n/probe/ @darz-probe-no-such-user-zz9q\n";

describe("an Unknown owner line whose every owner is flagged", () => {
  it("matches and leaves the path with no owner, not falling back to the earlier line", () => {
    const f = parseCodeowners(PROBE, [{ line: 3, column: 9, kind: "Unknown owner" }]);
    expect(ownersOf(f, "probe/a.txt")).toEqual({ owners: [], line: 3, ambiguous: false });
    expect(ownersOf(f, "README.md")).toEqual({ owners: ["@alice"], line: 2, ambiguous: false });
  });

  it("is still reported as a line GitHub flags", () => {
    const f = parseCodeowners(PROBE, [{ line: 3, column: 9, kind: "Unknown owner" }]);
    expect(f.ignoredLines).toEqual([{ line: 3, source: "/probe/ @darz-probe-no-such-user-zz9q" }]);
  });

  it("columns count from the start of the line as written, leading spaces included", () => {
    const f = parseCodeowners("* @alice\n  /probe/ @ghost\n", [{ line: 2, column: 11, kind: "Unknown owner" }]);
    expect(ownersOf(f, "probe/a.txt").ambiguous).toBe(false);
  });

  it("applies with the owners not flagged when only some owners on the line are flagged", () => {
    const f = parseCodeowners("* @alice\n/probe/ @bob @ghost\n", [{ line: 2, column: 14, kind: "Unknown owner" }]);
    expect(ownersOf(f, "probe/a.txt")).toEqual({ owners: ["@bob"], line: 2, ambiguous: false });
  });

  it("an Invalid owner line is skipped, so the earlier line applies", () => {
    const f = parseCodeowners("* @alice\n/probe/ ghost\n", [{ line: 2, column: 9, kind: "Invalid owner" }]);
    expect(ownersOf(f, "probe/a.txt")).toEqual({ owners: ["@alice"], line: 1, ambiguous: false });
  });

  it("stays ambiguous when the error has no column", () => {
    const f = parseCodeowners(PROBE, [{ line: 3, kind: "Unknown owner" }]);
    expect(ownersOf(f, "probe/a.txt").ambiguous).toBe(true);
  });

  it("check 1 fails on the unowned gate file instead of reporting it ambiguous", async () => {
    const fx = goodFixture();
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "* @alice\n/.github/workflows/ @ghost\n")) };
    fx.codeownersErrors = ok({
      errors: [{ line: 2, column: 21, kind: "Unknown owner", source: "/.github/workflows/ @ghost\n", path: ".github/CODEOWNERS" }],
    });
    const a = await assess({ repo: REPO, fetch: fixtureFetch(fx).fetch, agents: ["coder-agent"], now: () => new Date("2026-11-23T12:00:00Z") });
    const r = a.checks.find((c) => c.id === "gate_files_owned");
    expect(r?.status).toBe("fail");
    expect(r?.reasons.find((x) => x.code === "gate_files_unowned")?.subjects).toEqual([".github/workflows/ci.yml"]);
  });
});
