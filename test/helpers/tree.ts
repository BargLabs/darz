// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../..", import.meta.url));

// The files in this repository: what git tracks, plus new files git would add
// (not ignored ones). This is the tree that ships, root files included, and it
// leaves out local scratch files. Symlinks and other non-regular files are
// skipped, so nothing follows a link out of the tree.
export function repoFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  const isFile = (f: string) => {
    try {
      return lstatSync(join(root, f)).isFile();
    } catch {
      return false; // tracked but deleted in the working tree
    }
  };
  return [...new Set(listed.split("\0").filter(Boolean))].filter(isFile).sort();
}
