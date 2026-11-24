// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assess } from "../src/assess.js";
import { canonicalize } from "../src/canonical.js";
import { buildRecord, serializeRecord } from "../src/record.js";
import { RECORD_FORMAT, TOOL_VERSION } from "../src/version.js";
import { FORBIDDEN, NOT_FOUND, REPO, fixtureFetch, goodFixture, pullRequestRule } from "./fixtures/github.js";
import { recordErrors } from "./helpers/schemas.js";

const now = () => new Date("2026-11-20T12:00:00.123Z");

function reorder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorder);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, reorder(v)]));
  }
  return value;
}

describe("RFC 8785 canonical JSON", () => {
  it("sorts keys by UTF-16 code units, as the RFC's example does", () => {
    const input = { "€": "Euro Sign", "\r": "Carriage Return", "דּ": "Hebrew Letter Dalet With Dagesh", "1": "One", "😀": "Emoji: Grinning Face", "\u0080": "Control", "ö": "Latin Small Letter O With Diaeresis" };
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("serialises numbers as ECMAScript does", () => {
    expect(canonicalize([1e21, 1e-7, 0.000001, -0, 333333333.3333333, 4.5, 2e-3])).toBe(
      "[1e+21,1e-7,0.000001,0,333333333.3333333,4.5,0.002]",
    );
  });

  it("escapes strings as the RFC requires", () => {
    expect(canonicalize({ s: "\u000f\n\"\\/ " })).toBe('{"s":"\\u000f\\n\\"\\\\/ "}');
  });

  it("has no whitespace and nests", () => {
    expect(canonicalize({ b: [true, null, { d: 1, c: "x" }], a: false })).toBe('{"a":false,"b":[true,null,{"c":"x","d":1}]}');
  });

  it("refuses values JSON cannot carry", () => {
    expect(() => canonicalize(Number.NaN)).toThrow();
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalize([undefined])).toThrow();
  });
});

describe("the record", () => {
  it("the same inputs in a different key order give identical bytes and the same SHA-256", async () => {
    const a = await assess({ repo: REPO, fetch: fixtureFetch(goodFixture()).fetch, agents: ["coder-agent"], now });
    const record = buildRecord(a, { agents: ["coder-agent"], agentApps: [], gates: [], merges: 50 });
    const shuffled = reorder(record) as typeof record;
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(record));
    const one = serializeRecord(record);
    const two = serializeRecord(shuffled);
    expect(Buffer.compare(one.bytes, two.bytes)).toBe(0);
    expect(one.sha256).toBe(two.sha256);
    expect(one.sha256).toBe(createHash("sha256").update(one.bytes).digest("hex"));
  });

  it("two runs over the same responses give the same bytes", async () => {
    const run = async () =>
      serializeRecord(
        buildRecord(await assess({ repo: REPO, fetch: fixtureFetch(goodFixture()).fetch, agents: ["coder-agent"], now }), {
          agents: ["coder-agent"],
          agentApps: [],
          gates: [],
          merges: 50,
        }),
      );
    expect((await run()).sha256).toBe((await run()).sha256);
  });

  it("carries the format, tool version, repository, branch, commit, readAt in UTC, reads, identities and checks", async () => {
    const a = await assess({ repo: REPO, fetch: fixtureFetch(goodFixture()).fetch, agents: ["coder-agent"], now });
    const r = buildRecord(a, { agents: ["coder-agent"], agentApps: [], gates: [], merges: 50 });
    expect(r.format).toBe("darz-record-0.2");
    expect(r.tool).toEqual({ name: "darz", version: "0.2.0" });
    expect(r.repository).toBe(REPO);
    expect(r.defaultBranch).toBe("main");
    expect(r.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.readAt).toBe("2026-11-20T12:00:00Z");
    expect(r.reads.find((x) => x.endpoint === `GET /repos/${REPO}`)?.state).toBe("read");
    expect(r.reads.find((x) => x.endpoint === `GET /repos/${REPO}/branches/main/protection`)?.state).toBe("read");
    expect(r.classicProtection).toEqual({ state: "present", basis: "read" });
    expect(r.agentIdentities).toEqual([{ kind: "user", login: "coder-agent", source: "declared", foundIn: ["flag"] }]);
    expect(r.checks).toHaveLength(6);
    expect(r.exitCode).toBe(0);
  });

  const variants: Array<[string, () => ReturnType<typeof goodFixture>]> = [
    ["good", goodFixture],
    [
      "failing",
      () => {
        const fx = goodFixture();
        fx.rules = [[pullRequestRule({ required_approving_review_count: 0 })]];
        return fx;
      },
    ],
    [
      "unverifiable",
      () => {
        const fx = goodFixture();
        fx.rules = FORBIDDEN;
        fx.collaborators = FORBIDDEN;
        return fx;
      },
    ],
    [
      "repository unreadable",
      () => {
        const fx = goodFixture();
        fx.repo = NOT_FOUND;
        return fx;
      },
    ],
  ];
  for (const [name, make] of variants) {
    it(`a ${name} record validates against schema/record-0.2.schema.json`, async () => {
      for (const agents of [["coder-agent"], []]) {
        const a = await assess({ repo: REPO, fetch: fixtureFetch(make()).fetch, agents, now });
        const r = JSON.parse(serializeRecord(buildRecord(a, { agents, agentApps: [], gates: [], merges: 50 })).bytes.toString("utf8"));
        expect(recordErrors(r)).toEqual([]);
      }
    });
  }

  it("the schema rejects a record with an unknown status", async () => {
    const a = await assess({ repo: REPO, fetch: fixtureFetch(goodFixture()).fetch, agents: ["coder-agent"], now });
    const r = JSON.parse(serializeRecord(buildRecord(a, { agents: [], agentApps: [], gates: [], merges: 50 })).bytes.toString("utf8"));
    r.checks[0].status = "ok";
    expect(recordErrors(r)).not.toEqual([]);
  });
});

describe("record formats", () => {
  // v0.1.0 was released with schema/record-0.1.schema.json as it stood before
  // the GraphQL reader. A record format, once released, does not change: the
  // reader's fields are format darz-record-0.2.
  it("schema/record-0.1.schema.json is byte for byte the file released in v0.1.0", () => {
    const bytes = readFileSync(new URL("../schema/record-0.1.schema.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "fbc1377e1de14927b784c9d5d351240e53a4232805441b35c07ecb813a11ea10",
    );
  });

  // Format 0.2 shipped in the code while the tool still said 0.1.0.
  // A tool version older than the record format it writes reads as a release
  // that cannot have written that format.
  it("the tool version is not older than the record format it writes", () => {
    const format = /^darz-record-(\d+)\.(\d+)$/.exec(RECORD_FORMAT);
    const tool = /^(\d+)\.(\d+)\.(\d+)$/.exec(TOOL_VERSION);
    expect(format, RECORD_FORMAT).not.toBeNull();
    expect(tool, TOOL_VERSION).not.toBeNull();
    const [fMajor, fMinor] = [Number(format?.[1]), Number(format?.[2])];
    const [tMajor, tMinor] = [Number(tool?.[1]), Number(tool?.[2])];
    expect(tMajor > fMajor || (tMajor === fMajor && tMinor >= fMinor), `tool ${TOOL_VERSION} writes ${RECORD_FORMAT}`).toBe(true);
  });

  it("schema/record-0.2.schema.json is for format darz-record-0.2", () => {
    const schema = JSON.parse(readFileSync(new URL("../schema/record-0.2.schema.json", import.meta.url), "utf8"));
    expect(schema.properties.format).toEqual({ const: "darz-record-0.2" });
  });
});
