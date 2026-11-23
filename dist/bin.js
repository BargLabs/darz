#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { main } from "./cli.js";
// Redirects are not followed, so no host other than the API URL is ever called.
const fetchOnce = (url, init) => fetch(url, { method: init.method, headers: init.headers, redirect: "manual" });
main(process.argv.slice(2), {
    env: process.env,
    fetch: fetchOnce,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
}).then((code) => {
    process.exitCode = code;
}, () => {
    process.stderr.write("darz: internal error\n");
    process.exitCode = 70;
});
