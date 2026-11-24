// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Check 7, lessons_hold: each lesson on the default branch is in force only
// when the latest change to its file was approved, on the pull request's final
// head, by a person who is neither its author nor an agent identity. Lessons
// in force are run over the files at --ref (the default branch's head when not
// given). A lesson changed without approval fails the row; it is never dropped.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AssessOptions, assess } from "../src/assess.js";
import type { CheckRow } from "../src/checks/types.js";
import { main } from "../src/cli.js";
import { MAX_LESSONS, MAX_LESSON_FILE_READS } from "../src/lessons.js";
import { buildRecord, serializeRecord } from "../src/record.js";
import { buildSarif } from "../src/sarif.js";
import { FORBIDDEN, REPO, SHA, type Fixture, blobSha, fileBody, fixtureFetch, goodFixture, ok } from "./fixtures/github.js";
import {
  EARLIER_HEAD,
  HUMAN_AUTHOR,
  HUMAN_REVIEWER,
  LESSONS,
  type LessonFixture,
  PR_HEAD,
  REF,
  commitFor,
  lessonJson,
  pull,
  review,
  treeAtRoutes,
  withLessons,
} from "./fixtures/lessons.js";
import { recordErrors, sarifErrors } from "./helpers/schemas.js";

const now = () => new Date("2026-11-24T12:00:00Z");
const R = `/repos/${REPO}`;

const FORBID_TODO = { kind: "forbid", paths: ["src/**/*.ts"], pattern: "TODO(agent)", match: "literal" };
const REQUIRE_GUARD = { kind: "require", paths: ["src/**/*.ts"], pattern: "^// SPDX-License-Identifier: Apache-2\\.0$", match: "regex" };

const forbidTodo = (extra: Partial<LessonFixture> = {}): LessonFixture => ({
  name: "no-agent-todos.json",
  text: lessonJson("no-agent-todos", FORBID_TODO),
  ...extra,
});

async function run(fx: Fixture, o: Partial<AssessOptions> = {}) {
  const f = fixtureFetch(fx);
  const a = await assess({ repo: REPO, fetch: f.fetch, agents: ["coder-agent"], now, ...o });
  const row = a.checks.find((c) => c.id === "lessons_hold") as CheckRow;
  const lessons = (row?.details?.lessons ?? []) as Array<{
    id: string | null;
    file: string;
    status: string;
    reasons: Array<{ code: string; subjects?: string[] }>;
    approvers: string[];
    approval: { commit: string | null; pullRequest: number | null } | null;
  }>;
  return { a, row, lessons, calls: f.calls };
}

const codes = (row: CheckRow) => row.reasons.map((r) => r.code);
const subjects = (row: CheckRow, code: string) => row.reasons.find((r) => r.code === code)?.subjects ?? [];

/** A fixture whose head has src/a.ts with the given text. */
function fixtureWith(files: Record<string, string>, lessons: LessonFixture[]): Fixture {
  // goodFixture's tree has src/index.ts; give it text so lessons over src/ can read it.
  return withLessons(goodFixture(), lessons, { files: { "src/index.ts": "// SPDX-License-Identifier: Apache-2.0\nexport {};\n", ...files } });
}

describe("check 7: no lessons", () => {
  it("zero lessons is context, reason no_lessons, never a pass", async () => {
    const { a, row } = await run(goodFixture());
    expect(row.status).toBe("context");
    expect(codes(row)).toEqual(["no_lessons"]);
    expect(row.title).toBe("Approved lessons hold at the commit read");
    // Context does not change the exit code: every other check passes here.
    expect(buildRecord(a, { agents: ["coder-agent"], agentApps: [], gates: [], merges: 50 }).exitCode).toBe(0);
  });

  it("an empty lessons directory is also no_lessons", async () => {
    const fx = withLessons(goodFixture(), [], { dir: ok([]) });
    const { row } = await run(fx);
    expect(row.status).toBe("context");
    expect(codes(row)).toEqual(["no_lessons"]);
  });

  it("an unreadable lessons directory is unverifiable, never no_lessons", async () => {
    const fx = withLessons(goodFixture(), [], { dir: FORBIDDEN });
    const { row } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(codes(row)).toContain("lessons_unreadable");
  });
});

describe("check 7: approval", () => {
  it("approved by another person on the final head: in force, and the row passes", async () => {
    const { row, lessons } = await run(fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]));
    expect(row.status).toBe("pass");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]).toMatchObject({
      id: "no-agent-todos",
      file: `${LESSONS}/no-agent-todos.json`,
      status: "pass",
      approvers: [HUMAN_REVIEWER],
      approval: { commit: commitFor(`${LESSONS}/no-agent-todos.json`), pullRequest: 40 },
    });
  });

  it("approved only by the author: lesson_unapproved, and the row fails", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ reviews: [[review(HUMAN_AUTHOR, "APPROVED")]] })]);
    const { row, lessons } = await run(fx);
    expect(row.status).toBe("fail");
    expect(codes(row)).toContain("lesson_unapproved");
    expect(subjects(row, "lesson_unapproved").join(" ")).toContain(`${LESSONS}/no-agent-todos.json`);
    expect(lessons[0]?.status).toBe("fail");
    expect(lessons[0]?.approvers).toEqual([]);
  });

  it("approved only by an agent identity: lesson_unapproved", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ reviews: [[review("coder-agent", "APPROVED")]] })]);
    const { row } = await run(fx);
    expect(row.status).toBe("fail");
    expect(codes(row)).toContain("lesson_unapproved");
  });

  it("approved only by a bot account, declared or not: lesson_unapproved", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ reviews: [[review("helper[bot]", "APPROVED", PR_HEAD, "Bot")]] })]);
    const { row } = await run(fx, { agents: [] });
    expect(row.status).toBe("fail");
    expect(codes(row)).toContain("lesson_unapproved");
  });

  it("approved on an earlier head only: lesson_unapproved", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ reviews: [[review(HUMAN_REVIEWER, "APPROVED", EARLIER_HEAD)]] })]);
    const { row } = await run(fx);
    expect(row.status).toBe("fail");
    expect(codes(row)).toContain("lesson_unapproved");
  });

  it("an approval later replaced by a request for changes does not count", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [
      forbidTodo({ reviews: [[review(HUMAN_REVIEWER, "APPROVED"), review(HUMAN_REVIEWER, "CHANGES_REQUESTED")]] }),
    ]);
    const { row } = await run(fx);
    expect(row.status).toBe("fail");
    expect(codes(row)).toContain("lesson_unapproved");
  });

  it("a direct push with no pull request: lesson_unapproved, no_pull_request", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ pulls: [[]] })]);
    const { row } = await run(fx);
    expect(row.status).toBe("fail");
    expect(subjects(row, "lesson_unapproved").join(" ")).toContain("no_pull_request");
  });

  it("a pull request that was never merged into the default branch is not the lesson's approval", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ pulls: [[pull(40, { merged: false }), pull(41, { base: "dev" })]] })]);
    const { row } = await run(fx);
    expect(row.status).toBe("fail");
    expect(subjects(row, "lesson_unapproved").join(" ")).toContain("no_pull_request");
  });

  it("reviews split over two pages, with the counting approval on the second: in force", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [
      forbidTodo({ reviews: [[review("carol", "COMMENTED")], [review(HUMAN_REVIEWER, "APPROVED")]] }),
    ]);
    const { row, calls } = await run(fx);
    expect(row.status).toBe("pass");
    expect(calls.some((c) => c.url.endsWith("/pulls/40/reviews?per_page=100&page=2"))).toBe(true);
  });

  it("a 403 on the reviews endpoint: unverifiable, never pass", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ reviews: FORBIDDEN })]);
    const { row, lessons } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(codes(row)).toContain("lesson_approval_unreadable");
    expect(lessons[0]?.status).toBe("unverifiable");
  });

  it("an unreadable commit list or pull request list: unverifiable", async () => {
    for (const bad of [{ commits: FORBIDDEN }, { pulls: FORBIDDEN }]) {
      const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo(bad)]);
      const { row } = await run(fx);
      expect(row.status).toBe("unverifiable");
      expect(codes(row)).toContain("lesson_approval_unreadable");
    }
  });

  it("a retired lesson changed without approval still fails: retiring is a change to its file", async () => {
    const text = lessonJson("no-agent-todos", FORBID_TODO, { retired: { on: "2026-11-24", reason: "Moved elsewhere." } });
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ text, pulls: [[]] })]);
    const { row } = await run(fx);
    expect(row.status).toBe("fail");
    expect(codes(row)).toContain("lesson_unapproved");
  });

  it("an unapproved lesson that is also violated reports both", async () => {
    const fx = fixtureWith({ "src/a.ts": "// TODO(agent) later\n" }, [forbidTodo({ pulls: [[]] })]);
    const { row } = await run(fx);
    expect(row.status).toBe("fail");
    expect(codes(row)).toContain("lesson_unapproved");
  });
});

describe("check 7: the lesson's check", () => {
  it("forbid with a hit fails with the file and line", async () => {
    const fx = fixtureWith({ "src/a.ts": "one\n// TODO(agent) fix\nthree\n", "src/b.ts": "fine\n" }, [forbidTodo()]);
    const { row, lessons } = await run(fx);
    expect(row.status).toBe("fail");
    expect(codes(row)).toEqual(["lesson_violated"]);
    expect(subjects(row, "lesson_violated")).toEqual(["no-agent-todos: src/a.ts:2"]);
    expect(lessons[0]?.status).toBe("fail");
  });

  it("forbid ignores files outside its paths", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n", "docs/notes.md": "TODO(agent) here\n" }, [forbidTodo()]);
    expect((await run(fx)).row.status).toBe("pass");
  });

  it("require with a missing match fails, naming each file without one", async () => {
    const fx = fixtureWith(
      { "src/a.ts": "// SPDX-License-Identifier: Apache-2.0\nx\n", "src/b.ts": "x\n" },
      [{ name: "spdx-header.json", text: lessonJson("spdx-header", REQUIRE_GUARD) }],
    );
    const { row } = await run(fx);
    expect(row.status).toBe("fail");
    expect(subjects(row, "lesson_violated")).toEqual(["spdx-header: src/b.ts has no matching line"]);
  });

  it("require with no matching files fails, no_matching_files", async () => {
    const lesson = { ...REQUIRE_GUARD, paths: ["lib/**/*.ts"] };
    const fx = fixtureWith({ "src/a.ts": "x\n" }, [{ name: "spdx-header.json", text: lessonJson("spdx-header", lesson) }]);
    const { row } = await run(fx);
    expect(row.status).toBe("fail");
    expect(subjects(row, "lesson_violated")).toEqual(["spdx-header: no_matching_files"]);
  });

  it("literal matching takes the pattern as text; regex matching compiles it", async () => {
    const literal = { kind: "forbid", paths: ["src/*.ts"], pattern: "a.b", match: "literal" };
    const regex = { ...literal, match: "regex" };
    const lit = await run(fixtureWith({ "src/a.ts": "axb\n" }, [{ name: "dots.json", text: lessonJson("dots", literal) }]));
    expect(lit.row.status).toBe("pass");
    const re = await run(fixtureWith({ "src/a.ts": "axb\n" }, [{ name: "dots.json", text: lessonJson("dots", regex) }]));
    expect(re.row.status).toBe("fail");
    expect(subjects(re.row, "lesson_violated")).toEqual(["dots: src/a.ts:1"]);
  });

  it("a pattern that does not compile is lesson_invalid, unverifiable, naming the file", async () => {
    const bad = { ...FORBID_TODO, pattern: "(unclosed", match: "regex" };
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [{ name: "bad-pattern.json", text: lessonJson("bad-pattern", bad) }]);
    const { row, lessons } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(subjects(row, "lesson_invalid").join(" ")).toContain(`${LESSONS}/bad-pattern.json`);
    expect(lessons[0]?.status).toBe("unverifiable");
  });

  it("a lesson file that is not valid JSON is lesson_invalid, never skipped", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [{ name: "broken.json", text: "{ nope" }, forbidTodo()]);
    const { row, lessons } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(codes(row)).toContain("lesson_invalid");
    expect(lessons.map((l) => l.file).sort()).toEqual([`${LESSONS}/broken.json`, `${LESSONS}/no-agent-todos.json`]);
  });

  it("a file over 1 MiB gives file_too_large, unverifiable, and is not read", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]);
    const entry = (fx.tree.body as { tree: Array<{ path: string; size?: number }> }).tree.find((e) => e.path === "src/a.ts");
    if (entry) entry.size = 1024 * 1024 + 1;
    const { row, calls } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(codes(row)).toContain("file_too_large");
    expect(calls.some((c) => c.url.endsWith(`/git/blobs/${blobSha("src/a.ts")}`))).toBe(false);
  });

  it("a line over 4096 characters gives file_too_large", async () => {
    const fx = fixtureWith({ "src/a.ts": `${"x".repeat(4097)}\n` }, [forbidTodo()]);
    const { row } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(codes(row)).toContain("file_too_large");
  });

  it("a truncated tree at the commit read gives tree_truncated, unverifiable", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]);
    (fx.tree.body as { truncated: boolean }).truncated = true;
    const { row } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(codes(row)).toContain("tree_truncated");
  });

  it("a retired lesson is not_in_force and does not affect the row", async () => {
    const retired = lessonJson("old-rule", { ...FORBID_TODO, pattern: "ok" }, { retired: { on: "2026-11-01", reason: "Replaced." } });
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo(), { name: "old-rule.json", text: retired }]);
    const { row, lessons } = await run(fx);
    expect(row.status).toBe("pass");
    expect(lessons.find((l) => l.id === "old-rule")?.status).toBe("not_in_force");

    const only = await run(fixtureWith({ "src/a.ts": "ok\n" }, [{ name: "old-rule.json", text: retired }]));
    expect(only.row.status).toBe("context");
    expect(codes(only.row)).toEqual(["no_lessons"]);
  });

  it(`more than ${MAX_LESSONS} lessons is too_many_lessons, unverifiable`, async () => {
    const entries = Array.from({ length: MAX_LESSONS + 1 }, (_, i) => ({
      type: "file",
      name: `lesson-${i}.json`,
      path: `${LESSONS}/lesson-${i}.json`,
      sha: "5".repeat(40),
    }));
    const fx = withLessons(goodFixture(), [], { dir: ok(entries) });
    const { row } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(codes(row)).toEqual(["too_many_lessons"]);
  });

  it(`more than ${MAX_LESSON_FILE_READS} files to read is lesson_read_cap, unverifiable, and none is read`, async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i <= MAX_LESSON_FILE_READS; i++) files[`src/f${i}.ts`] = `file ${i}\n`;
    const fx = fixtureWith(files, [forbidTodo()]);
    const { row, calls } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(codes(row)).toContain("lesson_read_cap");
    expect(calls.filter((c) => c.url.includes("/git/blobs/")).length).toBeLessThan(10);
  });

  it("a directory or a non-JSON file in the lessons directory is lesson_invalid", async () => {
    const dir = ok([
      { type: "dir", name: "drafts", path: `${LESSONS}/drafts`, sha: "6".repeat(40) },
    ]);
    const fx = withLessons(goodFixture(), [], { dir });
    const { row } = await run(fx);
    expect(row.status).toBe("unverifiable");
    expect(subjects(row, "lesson_invalid").join(" ")).toContain(`${LESSONS}/drafts`);
  });
});

describe("check 7: lessons come from the default branch, not from --ref", () => {
  it("with --ref at a commit that deletes the lesson file, the lesson is still read from the default branch and enforced", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]);
    // At REF the lesson file is gone and src/a.ts breaks the lesson.
    Object.assign(fx.extra, treeAtRoutes(REF, { "src/a.ts": "// TODO(agent) sneak\n", "README.md": "x\n" }));
    const { a, row, calls } = await run(fx, { ref: REF });
    expect(row.status).toBe("fail");
    expect(subjects(row, "lesson_violated")).toEqual(["no-agent-todos: src/a.ts:1"]);
    // The lessons were read at the default branch's head, and nothing was read at REF for them.
    expect(calls.some((c) => c.url.endsWith(`${R}/contents/${LESSONS}?ref=${SHA}`))).toBe(true);
    expect(calls.some((c) => c.url.includes(`contents/${LESSONS}`) && c.url.includes(REF))).toBe(false);
    // The other checks still read the default branch's head.
    expect(a.commitSha).toBe(SHA);
    expect(a.ref).toBe(REF);
    expect(row.read).toContain(`GET ${R}/git/trees/${REF}?recursive=1`);
  });

  it("without --ref, the ref is the default branch's head and its tree is not read twice", async () => {
    const { a, calls } = await run(fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]));
    expect(a.ref).toBe(SHA);
    expect(calls.filter((c) => c.url.includes(`/git/trees/${SHA}`))).toHaveLength(1);
  });

  it("with no lesson in force, nothing is read at --ref", async () => {
    const { row, calls } = await run(goodFixture(), { ref: REF });
    expect(row.status).toBe("context");
    expect(calls.some((c) => c.url.includes(REF))).toBe(false);
  });

  it("an unreadable tree at --ref is tree_unreadable, unverifiable", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]);
    const { row } = await run(fx, { ref: REF });
    expect(row.status).toBe("unverifiable");
    expect(codes(row)).toContain("tree_unreadable");
  });

  it("the CLI takes --ref as a full commit SHA and refuses anything else", async () => {
    const cli = async (args: string[]) => {
      let stderr = "";
      const code = await main(["--out", mkdtempSync(join(tmpdir(), "darz-ref-")), ...args], {
        env: {},
        fetch: fixtureFetch(goodFixture()).fetch,
        stdout: () => {},
        stderr: (s) => {
          stderr += s;
        },
        now,
      });
      return { code, stderr };
    };
    for (const bad of ["main", "abc123", "HEAD~1", "G".repeat(40)]) {
      const r = await cli([REPO, "--ref", bad]);
      expect(r.code, bad).toBe(64);
      expect(r.stderr).toMatch(/--ref/);
    }
    expect((await cli([REPO, "--ref", REF])).code).not.toBe(64);
  });
});

describe("check 7: lesson files are gate files", () => {
  it("a lesson file with no code owner fails check 1", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]);
    fx.codeowners = { ".github/CODEOWNERS": ok(fileBody(".github/CODEOWNERS", "/.github/workflows/ @alice\n/.github/CODEOWNERS @alice\n/vitest.config.ts @alice\n")) };
    const { a } = await run(fx);
    const one = a.checks.find((c) => c.id === "gate_files_owned") as CheckRow;
    expect(one.status).toBe("fail");
    expect(subjects(one, "gate_files_unowned")).toContain(`${LESSONS}/no-agent-todos.json`);
  });
});

describe("check 7: record and SARIF", () => {
  const variants: Array<[string, () => Fixture]> = [
    ["passing", () => fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()])],
    ["violated", () => fixtureWith({ "src/a.ts": "TODO(agent)\n" }, [forbidTodo()])],
    ["unapproved", () => fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ pulls: [[]] })])],
    ["no lessons", () => goodFixture()],
    ["invalid", () => fixtureWith({ "src/a.ts": "ok\n" }, [{ name: "broken.json", text: "{" }])],
  ];
  for (const [name, make] of variants) {
    it(`a ${name} record validates against schema/record-0.3.schema.json and its SARIF against SARIF 2.1.0`, async () => {
      const { a } = await run(make());
      const record = buildRecord(a, { agents: ["coder-agent"], agentApps: [], gates: [], merges: 50 });
      const parsed = JSON.parse(serializeRecord(record).bytes.toString("utf8"));
      expect(recordErrors(parsed)).toEqual([]);
      expect(parsed.format).toBe("darz-record-0.3");
      expect(parsed.ref).toBe(SHA);
      expect(sarifErrors(buildSarif(a))).toEqual([]);
    });
  }

  it("records --ref in the record's options and as ref", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]);
    Object.assign(fx.extra, treeAtRoutes(REF, { "src/a.ts": "ok\n" }));
    const { a } = await run(fx, { ref: REF });
    const record = buildRecord(a, { agents: ["coder-agent"], agentApps: [], gates: [], merges: 50, ref: REF });
    expect(record.ref).toBe(REF);
    expect(record.options.ref).toBe(REF);
    expect(recordErrors(JSON.parse(serializeRecord(record).bytes.toString("utf8")))).toEqual([]);
  });

  it("the same inputs in a different key order give identical bytes", async () => {
    const { a } = await run(fixtureWith({ "src/a.ts": "TODO(agent)\n" }, [forbidTodo()]));
    const record = buildRecord(a, { agents: ["coder-agent"], agentApps: [], gates: [], merges: 50 });
    const reorder = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reorder)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, reorder(x)]))
          : v;
    const one = serializeRecord(record);
    const two = serializeRecord(reorder(record) as typeof record);
    expect(Buffer.compare(one.bytes, two.bytes)).toBe(0);
  });

  it("SARIF: one error per violated lesson at the file and line; one per unapproved lesson at the lesson file", async () => {
    const fx = fixtureWith({ "src/a.ts": "one\nTODO(agent)\n" }, [
      forbidTodo(),
      { name: "spdx-header.json", text: lessonJson("spdx-header", { ...REQUIRE_GUARD, paths: ["lib/*.ts"] }), pulls: [[]] },
    ]);
    const { a } = await run(fx);
    const sarif = buildSarif(a) as any;
    expect(sarifErrors(sarif)).toEqual([]);
    const results = sarif.runs[0].results.filter((r: any) => r.ruleId === "darz/lessons_hold");
    const at = (r: any) => r.locations.map((l: any) => [l.physicalLocation.artifactLocation.uri, l.physicalLocation.region.startLine]);
    const violated = results.find((r: any) => r.properties.lesson === "no-agent-todos");
    expect(violated.level).toBe("error");
    expect(at(violated)).toEqual([["src/a.ts", 2]]);
    const unapproved = results.find((r: any) => r.properties.lesson === "spdx-header");
    expect(unapproved.level).toBe("error");
    expect(at(unapproved)[0]).toEqual([`${LESSONS}/spdx-header.json`, 1]);
    expect(sarif.runs[0].properties.ref).toBe(SHA);
  });

  it("SARIF: an unverifiable lesson is a warning at its lesson file", async () => {
    const { a } = await run(fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo({ reviews: FORBIDDEN })]));
    const sarif = buildSarif(a) as any;
    const r = sarif.runs[0].results.find((x: any) => x.ruleId === "darz/lessons_hold");
    expect(r.level).toBe("warning");
    expect(r.locations[0].physicalLocation.artifactLocation.uri).toBe(`${LESSONS}/no-agent-todos.json`);
  });

  it("no lessons gives no SARIF result", async () => {
    const { a } = await run(goodFixture());
    const sarif = buildSarif(a) as any;
    expect(sarif.runs[0].results.filter((r: any) => r.ruleId === "darz/lessons_hold")).toEqual([]);
  });
});

describe("check 7: read-only", () => {
  it("every request is a GET", async () => {
    const fx = fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]);
    Object.assign(fx.extra, treeAtRoutes(REF, { "src/a.ts": "ok\n" }));
    const { calls } = await run(fx, { ref: REF });
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  });

  it("the latest change is found with one page of one commit, not a history read", async () => {
    const { calls } = await run(fixtureWith({ "src/a.ts": "ok\n" }, [forbidTodo()]));
    const commitReads = calls.filter((c) => c.url.includes(`${R}/commits?`));
    expect(commitReads).toHaveLength(1);
    expect(commitReads[0]?.url).toContain("per_page=1");
  });
});

describe("check 7: this repository's own lesson", () => {
  it("validates and its pattern holds in src/github/client.ts", () => {
    const text = readFileSync(new URL("../.github/darz/lessons/client-refuses-non-get.json", import.meta.url), "utf8");
    const lesson = JSON.parse(text);
    const client = readFileSync(new URL("../src/github/client.ts", import.meta.url), "utf8");
    expect(lesson.check.kind).toBe("require");
    expect(client.split("\n").some((l) => l.includes(lesson.check.pattern))).toBe(true);
  });
});
