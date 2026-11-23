// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

/**
 * JSON Canonicalization Scheme, RFC 8785: no whitespace, object keys sorted
 * by UTF-16 code units, strings and numbers serialised as ECMAScript's
 * JSON.stringify does. Values JSON cannot carry are refused, never dropped.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot carry a non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((v) => {
            if (v === undefined) throw new TypeError("canonical JSON cannot carry undefined in an array");
            return canonicalize(v);
          })
          .join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonical JSON cannot carry a ${typeof value}`);
  }
}
