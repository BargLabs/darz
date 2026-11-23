// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import type { CheckRow } from "./checks/types.js";

export const EXIT = {
  pass: 0,
  fail: 1,
  unverifiable: 2,
  repositoryUnreadable: 3,
  usage: 64,
  internal: 70,
} as const;

/** An unverifiable row never exits 0. */
export function exitCodeFor(repositoryReadable: boolean, checks: readonly CheckRow[]): 0 | 1 | 2 | 3 {
  if (!repositoryReadable) return 3;
  if (checks.some((c) => c.status === "fail")) return 1;
  if (checks.some((c) => c.status === "unverifiable")) return 2;
  return 0;
}

export const EXIT_MEANING: Record<number, string> = {
  0: "every check passed",
  1: "at least one check failed",
  2: "no check failed, but at least one is unverifiable",
  3: "the repository itself could not be read",
};
