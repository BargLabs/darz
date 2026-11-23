// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import AjvModule from "ajv";
import AjvDraft04Module from "ajv-draft-04";
import addFormatsModule from "ajv-formats";

// ajv ships CommonJS; under NodeNext the constructors sit on `.default`.
const Ajv = AjvModule.default;
const AjvDraft04 = AjvDraft04Module.default;
const addFormats = addFormatsModule.default;

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const recordSchema = JSON.parse(readFileSync(here("../../schema/record-0.1.schema.json"), "utf8"));
// Source: https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json
// (vendored unmodified; see test/vendor/SOURCE.md)
const sarifSchema = JSON.parse(readFileSync(here("../vendor/sarif-schema-2.1.0.json"), "utf8"));

const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validateRecordFn = ajv.compile(recordSchema);

const ajv04 = new AjvDraft04({ allErrors: true, strict: false });
addFormats(ajv04);
const validateSarifFn = ajv04.compile(sarifSchema);

export function recordErrors(record: unknown): string[] {
  return validateRecordFn(record) ? [] : (validateRecordFn.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`);
}

export function sarifErrors(sarif: unknown): string[] {
  return validateSarifFn(sarif) ? [] : (validateSarifFn.errors ?? []).map((e: { instancePath: string; message?: string }) => `${e.instancePath} ${e.message}`);
}
