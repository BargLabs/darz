// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { describe, expect, it } from "vitest";
import { scanWorkflow } from "../src/workflows.js";

const wf = (s: string) => scanWorkflow(s.replace(/^\n/, ""));

describe("scanWorkflow: pull-request triggers", () => {
  it("a scalar on: pull_request", () => {
    expect(wf(`on: pull_request\n`).pullRequest).toBe(true);
  });
  it("an inline list", () => {
    expect(wf(`on: [push, pull_request]\n`).pullRequest).toBe(true);
  });
  it("a block map", () => {
    expect(wf(`on:\n  pull_request:\n    branches: [main]\n`).pullRequest).toBe(true);
  });
  it("a block list", () => {
    expect(wf(`on:\n  - push\n  - pull_request_target\n`).pullRequest).toBe(true);
  });
  it("pull_request_target counts", () => {
    expect(wf(`on: pull_request_target\n`).pullRequest).toBe(true);
  });
  it("push only does not", () => {
    expect(wf(`on: [push, workflow_dispatch]\n`).pullRequest).toBe(false);
  });
  it("a key named pull_request_review does not count", () => {
    expect(wf(`on:\n  pull_request_review:\n    types: [submitted]\n`).pullRequest).toBe(false);
  });
});

describe("scanWorkflow: checks: write", () => {
  it("workflow-level permissions grant it", () => {
    expect(wf(`on: pull_request\npermissions:\n  checks: write\n`).checksWrite).toBe("granted");
  });
  it("write-all grants it", () => {
    expect(wf(`on: pull_request\npermissions: write-all\n`).checksWrite).toBe("granted");
  });
  it("a job-level permissions grant it", () => {
    expect(wf(`on: pull_request\njobs:\n  unit:\n    permissions:\n      checks: write\n    runs-on: ubuntu-latest\n`).checksWrite).toBe("granted");
  });
  it("read-all denies it", () => {
    expect(wf(`on: pull_request\npermissions: read-all\n`).checksWrite).toBe("none");
  });
  it("an empty map denies it", () => {
    expect(wf(`on: pull_request\npermissions: {}\n`).checksWrite).toBe("none");
  });
  it("a permissions block without checks denies it", () => {
    expect(wf(`on: pull_request\npermissions:\n  contents: read\n  pull-requests: write\n`).checksWrite).toBe("none");
  });
  it("checks: read denies it", () => {
    expect(wf(`on: pull_request\npermissions:\n  checks: read\n`).checksWrite).toBe("none");
  });
  it("no permissions block at all is default", () => {
    expect(wf(`on: pull_request\njobs:\n  unit:\n    runs-on: ubuntu-latest\n`).checksWrite).toBe("default");
  });
  it("a workflow default of read-all covers a job with no permissions", () => {
    expect(wf(`on: pull_request\npermissions: read-all\njobs:\n  unit:\n    runs-on: ubuntu-latest\n`).checksWrite).toBe("none");
  });
  it("a job that grants it beside one that does not is granted", () => {
    const text = `on: pull_request\njobs:\n  a:\n    permissions:\n      contents: read\n    runs-on: ubuntu-latest\n  b:\n    permissions:\n      checks: write\n    runs-on: ubuntu-latest\n`;
    expect(wf(text).checksWrite).toBe("granted");
  });
  it("a job without permissions under a write-all workflow is granted", () => {
    expect(wf(`on: pull_request\npermissions: write-all\njobs:\n  unit:\n    runs-on: ubuntu-latest\n`).checksWrite).toBe("granted");
  });
});

describe("scanWorkflow: shapes written other ways", () => {
  it("a flow map grants it at workflow level", () => {
    expect(wf(`on: pull_request\npermissions: { checks: write }\n`).checksWrite).toBe("granted");
  });
  it("a flow map grants it at job level", () => {
    expect(wf(`on: pull_request\njobs:\n  a:\n    permissions: {checks: write, contents: read}\n    runs-on: ubuntu-latest\n`).checksWrite).toBe(
      "granted",
    );
  });
  it("a flow map without checks denies it", () => {
    expect(wf(`on: pull_request\npermissions: { contents: read, "pull-requests": write }\n`).checksWrite).toBe("none");
  });
  it("a double- or single-quoted on key is the trigger key", () => {
    expect(wf(`"on": pull_request\npermissions:\n  checks: write\n`)).toEqual({ pullRequest: true, checksWrite: "granted" });
    expect(wf(`'on':\n  pull_request:\n`).pullRequest).toBe(true);
  });
  it("a quoted permissions or checks key is read", () => {
    expect(wf(`on: pull_request\n"permissions":\n  'checks': "write"\n`).checksWrite).toBe("granted");
  });
  it("Windows line endings are read", () => {
    expect(wf(`on: pull_request\r\npermissions:\r\n  checks: write\r\n`)).toEqual({ pullRequest: true, checksWrite: "granted" });
    expect(wf(`on: pull_request\r\npermissions: write-all\r\n`).checksWrite).toBe("granted");
  });
  it("a flow map on on: is read", () => {
    expect(wf(`on: { pull_request: {} }\npermissions:\n  checks: write\n`).pullRequest).toBe(true);
    expect(wf(`on: {push: {branches: [main]}, workflow_dispatch: }\n`).pullRequest).toBe(false);
  });
});

describe("scanWorkflow: not permissions", () => {
  it("checks: write inside a step's with: is not a permission grant", () => {
    const text = `on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: some/action\n        with:\n          checks: write\n`;
    expect(wf(text).checksWrite).toBe("default");
  });
  it("a top-level key after jobs is not read as a job", () => {
    const text = `on: pull_request\njobs:\n  a:\n    runs-on: ubuntu-latest\nenv:\n  FOO: bar\n`;
    expect(wf(text).checksWrite).toBe("default");
  });
});

describe("scanWorkflow: shapes it cannot read", () => {
  it("a block scalar on permissions is unknown", () => {
    expect(wf(`on: pull_request\npermissions: |\n  checks: write\n`).checksWrite).toBe("unknown");
  });
  it("a block scalar on on: leaves the trigger unknown", () => {
    expect(wf(`on: |\n  pull_request\npermissions:\n  checks: write\n`)).toEqual({ pullRequest: null, checksWrite: "granted" });
  });
  it("an alias as permissions is unknown, at workflow and job level", () => {
    expect(wf(`on: pull_request\npermissions: *p\n`).checksWrite).toBe("unknown");
    expect(wf(`on: pull_request\njobs:\n  a:\n    permissions: *p\n    runs-on: ubuntu-latest\n`).checksWrite).toBe("unknown");
  });
  it("an alias as checks is unknown", () => {
    expect(wf(`on: pull_request\npermissions:\n  checks: *w\n`).checksWrite).toBe("unknown");
  });
  it("an alias as on: leaves the trigger unknown", () => {
    expect(wf(`on: *triggers\n`).pullRequest).toBeNull();
  });
  it("a merge key in a job is unknown", () => {
    expect(wf(`on: pull_request\njobs:\n  a:\n    <<: *defaults\n    runs-on: ubuntu-latest\n`).checksWrite).toBe("unknown");
  });
  it("an anchored value is still read", () => {
    expect(wf(`on: pull_request\npermissions: &p\n  checks: write\n`).checksWrite).toBe("granted");
  });
  it("a flow list spread over lines leaves the trigger unknown", () => {
    expect(wf(`on: [push,\n  pull_request]\n`).pullRequest).toBeNull();
  });
  it("a permissions value GitHub does not accept is unknown", () => {
    expect(wf(`on: pull_request\npermissions: write\n`).checksWrite).toBe("unknown");
  });
  it("a comment after a value is ignored", () => {
    expect(wf(`on: pull_request  # only PRs\npermissions:\n  checks: write # needed\n`).checksWrite).toBe("granted");
  });
  it("a # inside a quoted trigger is not a comment", () => {
    const s = wf(`on:\n  pull_request:\n    branches: ["release/#1"]\n`);
    expect(s.pullRequest).toBe(true);
  });
});
