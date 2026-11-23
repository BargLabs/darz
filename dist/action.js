// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
/**
 * The GitHub Action entry point. It runs the same read-only CLI with inputs
 * taken from the environment GitHub Actions sets, then writes step outputs and
 * a job summary to the files GitHub Actions names. It makes no write call to
 * any API: uploading darz.sarif to code scanning is a separate step in the
 * caller's workflow (github/codeql-action/upload-sarif).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { main } from "./cli.js";
import { EXIT_MEANING } from "./exit.js";
export const ACTION_INPUTS = [
    "repository",
    "token",
    "agents",
    "agent-apps",
    "gates",
    "merges",
    "out-dir",
    "api-url",
    "fail-on",
];
/** Rows these reasons make unverifiable become readable with a token that has Administration: read. */
const TOKEN_LIMITED = new Set(["classic_protection_unreadable", "bypass_list_unreadable", "collaborators_unreadable"]);
const TOKEN_ENV = "DARZ_ACTION_TOKEN";
function input(env, name) {
    return (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}
function list(value) {
    return value
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
export function inputsToRun(env) {
    const failOn = input(env, "fail-on") || "fail";
    if (failOn !== "fail" && failOn !== "unverifiable" && failOn !== "never") {
        throw new Error(`fail-on must be fail, unverifiable or never, not "${failOn}"`);
    }
    const outDir = input(env, "out-dir") || "darz-out";
    const argv = [input(env, "repository")];
    const apiUrl = input(env, "api-url");
    if (apiUrl)
        argv.push("--api-url", apiUrl);
    argv.push("--out", outDir);
    const merges = input(env, "merges");
    if (merges)
        argv.push("--merges", merges);
    argv.push("--token-env", TOKEN_ENV);
    for (const a of list(input(env, "agents")))
        argv.push("--agent", a);
    for (const a of list(input(env, "agent-apps")))
        argv.push("--agent-app", a);
    for (const g of list(input(env, "gates")))
        argv.push("--gate", g);
    const token = input(env, "token");
    return { argv, env: token ? { [TOKEN_ENV]: token } : {}, failOn, outDir };
}
/**
 * The step's exit code. A failed check fails the step unless fail-on is never;
 * an unverifiable row fails it only with fail-on unverifiable. An unreadable
 * repository (3), a usage error (64) or an internal error (70) always fails it.
 */
export function actionExitCode(darzExit, failOn) {
    if (darzExit === 0)
        return 0;
    if (darzExit === 1)
        return failOn === "never" ? 0 : 1;
    if (darzExit === 2)
        return failOn === "unverifiable" ? 1 : 0;
    return 1;
}
function escapeCell(s) {
    return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function summaryMarkdown(record, sha256, exitCode, tokenLimited) {
    const head = record.commitSha ? `${record.defaultBranch} @ \`${record.commitSha.slice(0, 12)}\`` : "default branch unread";
    const lines = [
        `## Darz: ${record.repository} (${head})`,
        "",
        "| # | Check | Result | Reasons |",
        "|---|---|---|---|",
    ];
    (record.checks ?? []).forEach((c, i) => {
        const why = c.reasons.map((r) => `\`${r.code}\``).join(", ");
        lines.push(`| ${i + 1} | \`${c.id}\` | ${c.status} | ${escapeCell(why)} |`);
    });
    lines.push("", `Exit code ${exitCode}: ${EXIT_MEANING[exitCode] ?? "see the record"}.`);
    if (tokenLimited) {
        lines.push("", "Some settings are not readable with this token, so the rows that depend on them are unverifiable, not failed. " +
            "Classic branch protection needs administration access, a ruleset's bypass list needs write access to the ruleset, " +
            "and the collaborators list needs push access. " +
            "For a full check, pass a token with Administration: read (a fine-grained token or a GitHub App installation token) " +
            "as `token`, from a secret. On a branch protected only by rulesets, one more thing applies: GitHub answers 404 " +
            "for classic protection both when there is none and when the token may not read it. Darz takes that 404 as proof " +
            "of absence only from a classic token with the `repo` scope belonging to an admin, because only such a token says " +
            "what it may read. That token can also write, so weigh that before storing it as a secret; Darz itself only reads.");
    }
    lines.push("", `Record SHA-256: \`${sha256}\`. See docs/checks.md in BargLabs/darz for every reason.`, "");
    return lines.join("\n");
}
export async function runAction(io) {
    let run;
    try {
        run = inputsToRun(io.env);
    }
    catch (e) {
        io.stdout(`::error title=Darz::${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
    }
    const token = run.env[TOKEN_ENV];
    const darzExit = await main(run.argv, {
        env: run.env,
        fetch: io.fetch,
        stdout: io.stdout,
        stderr: io.stderr,
        ...(io.now ? { now: io.now } : {}),
    });
    const recordPath = join(run.outDir, "darz-record.json");
    const shaPath = join(run.outDir, "darz-record.json.sha256");
    const sarifPath = join(run.outDir, "darz.sarif");
    if (!existsSync(recordPath)) {
        io.stdout(`::error title=Darz::darz exited ${darzExit} without writing a record\n`);
        return actionExitCode(darzExit, run.failOn);
    }
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    const sha256 = existsSync(shaPath) ? (readFileSync(shaPath, "utf8").split(/\s+/)[0] ?? "") : "";
    const checks = record.checks ?? [];
    const failed = checks.filter((c) => c.status === "fail").map((c) => c.id);
    const unverifiable = checks.filter((c) => c.status === "unverifiable");
    const tokenLimited = unverifiable.some((c) => c.reasons.some((r) => TOKEN_LIMITED.has(r.code)));
    const outputs = {
        "exit-code": String(darzExit),
        record: recordPath,
        "record-sha256": sha256,
        sarif: sarifPath,
        pass: String(record.summary?.pass ?? 0),
        fail: String(record.summary?.fail ?? 0),
        unverifiable: String(record.summary?.unverifiable ?? 0),
    };
    const outputText = Object.entries(outputs)
        .map(([k, v]) => `${k}=${v}\n`)
        .join("");
    const summary = summaryMarkdown(record, sha256, darzExit, tokenLimited);
    if (token && (outputText.includes(token) || summary.includes(token))) {
        io.stdout("::error title=Darz::an output would have contained the token; stopped\n");
        return 1;
    }
    const outFile = io.env.GITHUB_OUTPUT;
    if (outFile)
        appendFileSync(outFile, outputText);
    const summaryFile = io.env.GITHUB_STEP_SUMMARY;
    if (summaryFile)
        appendFileSync(summaryFile, summary);
    if (failed.length > 0) {
        io.stdout(`::error title=Darz::${failed.length} check(s) failed: ${failed.join(", ")}. See the job summary.\n`);
    }
    else if (unverifiable.length > 0) {
        const ids = unverifiable.map((c) => c.id).join(", ");
        const hint = tokenLimited ? " A token with Administration: read gives a fuller check; see the job summary." : "";
        io.stdout(`::notice title=Darz::${unverifiable.length} check(s) unverifiable: ${ids}.${hint}\n`);
    }
    return actionExitCode(darzExit, run.failOn);
}
const isEntry = (() => {
    const entry = process.argv[1];
    return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
})();
if (isEntry) {
    const fetchOnce = (url, init) => fetch(url, { method: init.method, headers: init.headers, redirect: "manual" });
    runAction({
        env: process.env,
        fetch: fetchOnce,
        stdout: (s) => process.stdout.write(s),
        stderr: (s) => process.stderr.write(s),
    }).then((code) => {
        process.exitCode = code;
    }, () => {
        process.stdout.write("::error title=Darz::internal error\n");
        process.exitCode = 1;
    });
}
