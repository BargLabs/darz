#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { main } from "./cli.js";
import { platformFetch } from "./github/platform-fetch.js";

main(process.argv.slice(2), {
  env: process.env,
  fetch: platformFetch,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.stderr.write("darz: internal error\n");
    process.exitCode = 70;
  },
);
