// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// A lesson file is one JSON object per file at .github/darz/lessons/<id>.json.
// schema/lesson-0.1.schema.json describes it; parseLesson is the validator Darz
// runs, since Darz ships with no runtime dependencies. Both must be able to say
// no, and they must agree on what the schema can express.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import { LESSONS_DIR, parseLesson } from "../src/lessons.js";
import { root } from "./helpers/tree.js";

const Ajv = AjvModule.default;
const addFormats = addFormatsModule.default;
const schema = JSON.parse(readFileSync(join(root, "schema/lesson-0.1.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const schemaOk = (v: unknown) => validate(v) === true;

const GOOD = {
  id: "no-focused-tests",
  statement: "A test file never commits a focused test.",
  evidence: [{ kind: "commit", ref: "852138aa046cfddadca6b256f6c877f4ee51ac83" }],
  check: { kind: "forbid", paths: ["test/**/*.test.ts"], pattern: "\\.only\\(", match: "regex" },
};

const parse = (v: unknown, file = "no-focused-tests.json") => parseLesson(JSON.stringify(v), file);
const valid = (v: unknown, file?: string) => "lesson" in parse(v, file);

function without(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = structuredClone(GOOD);
  delete copy[key];
  return copy;
}

describe("lesson file: what is accepted", () => {
  it("a complete lesson validates in both", () => {
    expect(schemaOk(GOOD)).toBe(true);
    expect(valid(GOOD)).toBe(true);
  });

  it("a retired lesson validates in both", () => {
    const v = { ...GOOD, retired: { on: "2026-11-24", reason: "The suite moved to a runner that ignores focused tests." } };
    expect(schemaOk(v)).toBe(true);
    expect(valid(v)).toBe(true);
  });

  it("every evidence kind validates with a ref of its own shape", () => {
    const v = {
      ...GOOD,
      evidence: [
        { kind: "commit", ref: "852138aa046cfddadca6b256f6c877f4ee51ac83" },
        { kind: "pull_request", ref: "12" },
        { kind: "issue", ref: "3" },
        { kind: "url", ref: "https://example.com/post-mortem" },
      ],
    };
    expect(schemaOk(v)).toBe(true);
    expect(valid(v)).toBe(true);
  });

  it("parseLesson returns the lesson as written", () => {
    const got = parse(GOOD);
    expect(got).toEqual({ lesson: GOOD });
  });
});

describe("lesson file: the validator can say no", () => {
  const rejected: Array<[string, unknown]> = [
    ["no evidence", { ...GOOD, evidence: [] }],
    ["evidence missing", without("evidence")],
    ["a bad id (upper case)", { ...GOOD, id: "No-Focused-Tests" }],
    ["a bad id (too short)", { ...GOOD, id: "ab" }],
    ["a bad id (a slash)", { ...GOOD, id: "a/b-c" }],
    ["no statement", without("statement")],
    ["an empty statement", { ...GOOD, statement: "" }],
    ["a statement over two lines", { ...GOOD, statement: "One.\nTwo." }],
    ["an unknown top-level key", { ...GOOD, severity: "high" }],
    ["an unknown evidence kind", { ...GOOD, evidence: [{ kind: "chat", ref: "x" }] }],
    ["a commit ref that is not a full SHA", { ...GOOD, evidence: [{ kind: "commit", ref: "852138a" }] }],
    ["a pull request ref that is not a number", { ...GOOD, evidence: [{ kind: "pull_request", ref: "twelve" }] }],
    ["a url ref that is not https", { ...GOOD, evidence: [{ kind: "url", ref: "http://example.com/x" }] }],
    ["an unknown check kind", { ...GOOD, check: { ...GOOD.check, kind: "warn" } }],
    ["an unknown match", { ...GOOD, check: { ...GOOD.check, match: "glob" } }],
    ["no paths", { ...GOOD, check: { ...GOOD.check, paths: [] } }],
    ["an empty pattern", { ...GOOD, check: { ...GOOD.check, pattern: "" } }],
    ["an unknown check key", { ...GOOD, check: { ...GOOD.check, flags: "i" } }],
    ["a retired date that is not a date", { ...GOOD, retired: { on: "24 Nov 2026", reason: "x" } }],
    ["a retirement with no reason", { ...GOOD, retired: { on: "2026-11-24" } }],
    ["an array, not an object", [GOOD]],
  ];
  for (const [name, v] of rejected) {
    it(`rejects ${name}, in the schema and in parseLesson`, () => {
      expect(schemaOk(v), "schema").toBe(false);
      expect(valid(v), "parseLesson").toBe(false);
    });
  }

  it("rejects an id that differs from its file name (parseLesson; a schema cannot see the name)", () => {
    const got = parse(GOOD, "focused-tests.json");
    expect("problem" in got && got.problem).toMatch(/file name/);
  });

  it("rejects a regex pattern that does not compile with the u flag", () => {
    const got = parse({ ...GOOD, check: { ...GOOD.check, pattern: "(unclosed" } });
    expect("problem" in got && got.problem).toMatch(/pattern/);
    // Under the u flag a lone escape of an ordinary letter is a syntax error.
    expect(valid({ ...GOOD, check: { ...GOOD.check, pattern: "\\q" } })).toBe(false);
    // A literal pattern is not compiled, so the same text is a valid literal.
    expect(valid({ ...GOOD, check: { ...GOOD.check, pattern: "(unclosed", match: "literal" } })).toBe(true);
  });

  it("rejects text that is not JSON, naming the problem", () => {
    const got = parseLesson("{ not json", "no-focused-tests.json");
    expect("problem" in got && got.problem).toMatch(/JSON/);
  });

  it("rejects a file whose name is not <id>.json", () => {
    expect("problem" in parseLesson(JSON.stringify(GOOD), "no-focused-tests.txt")).toBe(true);
  });
});

describe("lesson files shipped with Darz", () => {
  it("the README's example lesson validates in both", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("\n## Lessons\n"));
    expect(readme.indexOf("\n## Lessons\n")).toBeGreaterThan(0);
    const block = /```json\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(block).toBeDefined();
    const example = JSON.parse(block as string);
    expect(schemaOk(example)).toBe(true);
    expect(parseLesson(block as string, `${example.id}.json`)).toEqual({ lesson: example });
  });

  it("each lesson in this repository validates in both and names a commit as evidence", () => {
    const dir = join(root, LESSONS_DIR);
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(schemaOk(JSON.parse(text)), f).toBe(true);
      const got = parseLesson(text, f);
      expect("lesson" in got, f).toBe(true);
      if ("lesson" in got) expect(got.lesson.evidence.some((e) => e.kind === "commit")).toBe(true);
    }
  });

  it("the schema is for lesson format 0.1 and allows no other keys", () => {
    expect(schema.$id).toMatch(/lesson-0\.1\.schema\.json$/);
    expect(schema.additionalProperties).toBe(false);
  });
});
