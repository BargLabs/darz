// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_MERGES, assess, parseRepo } from "./assess.js";
import { EXIT, EXIT_MEANING } from "./exit.js";
import { DEFAULT_API_URL } from "./github/client.js";
import { parseAppFlag } from "./github/snapshot.js";
import { identityName } from "./identities.js";
import { buildRecord, serializeRecord } from "./record.js";
import { buildSarif } from "./sarif.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";
export const USAGE = `Usage: darz <owner>/<repo> [options]

Reads a GitHub repository's settings and files (GET requests only) and reports,
per check, pass, fail or unverifiable.

Options:
  --agent <login>        an agent's user login (repeatable)
  --agent-app <slug>     an agent's GitHub App slug, or slug=id (repeatable)
  --gate <glob>          an extra gate-file pattern (repeatable)
  --merges <n>           merged pull requests to read for check 6 (default ${DEFAULT_MERGES})
  --out <dir>            output directory (default ./darz-out)
  --api-url <url>        API base URL (default ${DEFAULT_API_URL})
  --token-env <name>     environment variable holding the token (default GITHUB_TOKEN)
  --ref <sha>            the commit check 7 runs lessons over (default: the default
                         branch's head); lessons are always read from the head
  --graphql-ruleset-roles[=true|false]
                         also read ruleset bypass role names with GitHub's GraphQL API
                         (POST, compiled read-only queries; off by default)
  --version              print the version
  --help                 print this help

Exit codes: 0 every check passed; 1 a check failed; 2 none failed but one is
unverifiable; 3 the repository could not be read; 64 usage error.
`;
class UsageError extends Error {
}
const VALUE_FLAGS = new Set(["--agent", "--agent-app", "--gate", "--merges", "--out", "--api-url", "--token-env", "--ref"]);
function parseArgs(argv) {
    const p = {
        repo: "",
        agents: [],
        agentApps: [],
        gates: [],
        merges: DEFAULT_MERGES,
        out: "darz-out",
        apiUrl: DEFAULT_API_URL,
        tokenEnv: "GITHUB_TOKEN",
        graphqlRulesetRoles: false,
        ref: null,
    };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        let arg = argv[i];
        let value;
        if (arg === "--help" || arg === "-h")
            return "help";
        if (arg === "--version")
            return "version";
        if (arg.startsWith("--") && arg.includes("=")) {
            value = arg.slice(arg.indexOf("=") + 1);
            arg = arg.slice(0, arg.indexOf("="));
        }
        if (arg === "--graphql-ruleset-roles") {
            // A switch: bare, or =true / =false like the other --flag=value forms.
            const v = value?.toLowerCase();
            if (v !== undefined && v !== "true" && v !== "false") {
                throw new UsageError(`--graphql-ruleset-roles takes no value, or =true or =false, not "${value}"`);
            }
            p.graphqlRulesetRoles = v !== "false";
            continue;
        }
        if (!arg.startsWith("-")) {
            positional.push(arg);
            continue;
        }
        if (!VALUE_FLAGS.has(arg))
            throw new UsageError(`unknown option ${arg}`);
        if (value === undefined)
            value = argv[++i];
        // Checked for both `--flag value` and `--flag=value`: an empty `--agent=` from an
        // unset variable must not become an identity with an empty login.
        if (value === undefined || value.length === 0)
            throw new UsageError(`${arg} needs a value`);
        switch (arg) {
            case "--agent":
                p.agents.push(value);
                break;
            case "--agent-app":
                if (!parseAppFlag(value))
                    throw new UsageError(`--agent-app must be a slug or slug=id, not "${value}"`);
                p.agentApps.push(value);
                break;
            case "--gate":
                p.gates.push(value);
                break;
            case "--merges": {
                if (!/^[0-9]+$/.test(value))
                    throw new UsageError("--merges must be a whole number");
                const n = Number(value);
                if (n < 1 || n > 1000)
                    throw new UsageError("--merges must be between 1 and 1000");
                p.merges = n;
                break;
            }
            case "--out":
                p.out = value;
                break;
            case "--api-url":
                p.apiUrl = checkApiUrl(value);
                break;
            case "--ref":
                if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value))
                    throw new UsageError("--ref must be a full commit SHA: 40 or 64 lower-case hex characters");
                p.ref = value;
                break;
            case "--token-env":
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
                    throw new UsageError("--token-env must name an environment variable");
                p.tokenEnv = value;
                break;
        }
    }
    if (positional.length !== 1)
        throw new UsageError("give exactly one <owner>/<repo>");
    p.repo = positional[0];
    if (!parseRepo(p.repo))
        throw new UsageError(`not an <owner>/<repo>: ${p.repo}`);
    return p;
}
function checkApiUrl(value) {
    let u;
    try {
        u = new URL(value);
    }
    catch {
        throw new UsageError("--api-url is not a URL");
    }
    if (u.protocol !== "https:")
        throw new UsageError("--api-url must use https");
    if (u.username || u.password)
        throw new UsageError("--api-url must not carry credentials; use --token-env");
    if (u.search || u.hash)
        throw new UsageError("--api-url must not have a query or fragment");
    return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}
class TokenLeak extends Error {
}
export async function main(argv, io) {
    let token;
    const guard = (s) => {
        if (token && s.includes(token))
            throw new TokenLeak();
        return s;
    };
    const out = (s) => io.stdout(guard(s));
    const err = (s) => io.stderr(guard(s));
    let args;
    try {
        args = parseArgs(argv);
    }
    catch (e) {
        if (e instanceof UsageError) {
            io.stderr(`darz: ${e.message}\n\n${USAGE}`);
            return EXIT.usage;
        }
        throw e;
    }
    if (args === "help") {
        io.stdout(USAGE);
        return 0;
    }
    if (args === "version") {
        io.stdout(`${TOOL_NAME} ${TOOL_VERSION}\n`);
        return 0;
    }
    const a = args;
    const raw = io.env[a.tokenEnv];
    token = raw && raw.length > 0 ? raw : undefined;
    try {
        if (!token)
            err(`darz: no token in ${a.tokenEnv}; reading without authentication, so most settings will be unverifiable\n`);
        const assessment = await assess({
            repo: a.repo,
            fetch: io.fetch,
            apiUrl: a.apiUrl,
            ...(token ? { token } : {}),
            agents: a.agents,
            agentApps: a.agentApps,
            gates: a.gates,
            merges: a.merges,
            graphqlRulesetRoles: a.graphqlRulesetRoles,
            ...(a.ref !== null ? { ref: a.ref } : {}),
            ...(io.now ? { now: io.now } : {}),
        });
        const record = buildRecord(assessment, {
            agents: a.agents,
            agentApps: a.agentApps,
            gates: a.gates,
            merges: a.merges,
            graphqlRulesetRoles: a.graphqlRulesetRoles,
            ref: a.ref,
        });
        const { bytes, sha256 } = serializeRecord(record);
        guard(bytes.toString("utf8"));
        const sarifText = guard(`${JSON.stringify(buildSarif(assessment), null, 2)}\n`);
        const dir = resolve(a.out);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "darz-record.json"), bytes);
        writeFileSync(join(dir, "darz-record.json.sha256"), `${sha256}  darz-record.json\n`);
        writeFileSync(join(dir, "darz.sarif"), sarifText);
        const head = assessment.commitSha
            ? `${assessment.defaultBranch} @ ${assessment.commitSha.slice(0, 12)}`
            : (assessment.defaultBranch ?? "default branch unread");
        const lessonsAt = assessment.ref && assessment.ref !== assessment.commitSha ? `  lessons run at ${assessment.ref.slice(0, 12)}` : "";
        out(`${TOOL_NAME} ${TOOL_VERSION}  ${assessment.repository}  ${head}${lessonsAt}  read ${assessment.readAt}\n`);
        const width = Math.max(...assessment.checks.map((c) => c.id.length));
        for (const c of assessment.checks) {
            const why = c.reasons.map((r) => r.code).join(", ");
            out(`  ${c.status.padEnd(12)}  ${why ? `${c.id.padEnd(width)}  ${why}` : c.id}\n`);
        }
        const ids = assessment.identities;
        out(`agent identities: ${ids.length === 0 ? "none" : ids.map((i) => `${identityName(i)} (${i.source})`).join(", ")}\n`);
        out(`record  ${join(a.out, "darz-record.json")}  sha256 ${sha256}\n`);
        out(`sarif   ${join(a.out, "darz.sarif")}\n`);
        out(`exit ${record.exitCode}: ${EXIT_MEANING[record.exitCode]}\n`);
        return record.exitCode;
    }
    catch (e) {
        if (e instanceof TokenLeak) {
            io.stderr("darz: internal error: an output would have contained the token; stopped\n");
            return EXIT.internal;
        }
        const msg = e instanceof Error ? e.message : String(e);
        io.stderr(`darz: internal error: ${token ? msg.split(token).join("[redacted]") : msg}\n`);
        return EXIT.internal;
    }
}
