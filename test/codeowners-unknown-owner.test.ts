// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Issue 5, verified 23 Nov in a scratch repository:
//   line 2: * @houman44
//   line 3: /probe/ @darz-probe-no-such-user-zz9q   (codeowners/errors: Unknown owner, column 9)
// GitHub showed a code-owner shield for houman44 on README.md and none on
// probe/a.txt. So a line whose every owner is reported unknown still matches,
// as the last match, and leaves the path with no code owner: GitHub does not
// fall back to the earlier line. Other error kinds, and lines where only some
// owners are flagged, are not verified and stay ambiguous.

import { describe, expect, it } from "vitest";
import { ownersOf, parseCodeowners } from "../src/codeowners.js";
import { assess } from "../src/assess.js";
import { REPO, fileBody, fixtureFetch, goodFixture, ok } from "./fixtures/github.js";

const PROBE = "# probe\n* @houman44\n/probe/ @darz-probe-no-such-user-zz9q\n";

describe("an Unknown owner line whose every owner is flagged (issue 5)", () => {
  it("matches and leaves the path with no owner, not falling back to the earlier line", () => {
    const f = parseCodeowners(PROBE, [{ line: 3, column: 9, kind: "Unknown owner" }]);
    expect(ownersOf(f, "probe/a.txt")).toEqual({ owners: [], line: 3, ambiguous: false });
    expect(ownersOf(f, "README.md")).toEqual({ owners: ["@houman44"], line: 2, ambiguous: false });
  });

  it("is still reported as a line GitHub flags", () => {
    const f = parseCodeowners(PROBE, [{ line: 3, column: 9, kind: "Unknown owner" }]);
    expect(f.ignoredLines).toEqual([{ line: 3, source: "/probe/ @darz-probe-no-such-user-zz9q" }]);
  });

  it("columns count from the start of the line as written, leading spaces included", () => {
    const f = parseCodeowners("* @houman44\n  /probe/ @ghost\n", [{ line: 2, column: 11, kind: "Unknown owner" }]);
    expect(ownersOf(f, "probe/a.txt").ambiguous).toBe(false);
  });

  it("stays ambiguous when only some owners on the line are flagged (not verified)", () => {
    const f = parseCodeowners("* @houman44\n/probe/ @houman44 @ghost\n", [{ line: 2, column: 19, kind: "Unknown owner" }]);
    expect(ownersOf(f, "probe/a.txt")).toEqual({ owners: [], line: 2, ambiguous: true });
  });

  it("stays ambiguous for another error kind (not verified)", () => {
    const f = parseCodeowners("* @houman44\n/probe/ @ghost\n", [{ line: 2, column: 9, kind: "Invalid owner" }]);
    expect(ownersOf(f, "probe/a.txt").ambiguous).toBe(true);
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
