# Darz

Darz checks whether a repository stops AI coding agents from changing the rules that judge their work.

An agent has no gate if it can do any of these:

- edit its own CI;
- loosen its own tests;
- approve its own pull request;
- merge its own pull request.

Darz reads a repository's settings and files and reports `pass`, `fail` or `unverifiable` for each check, with the setting or file it read. It fails closed when it cannot decide, uses no AI model, and writes a record anyone can re-run.

**Status: v0.3.0, early. GitHub only. Use the GitHub Action pinned to a release's full commit SHA, or install from source.**

## Install from source

You need Node 22 or later and pnpm.

```sh
git clone https://github.com/BargLabs/darz
cd darz
pnpm install --frozen-lockfile
pnpm build
node dist/bin.js --help
```

Darz has no runtime dependencies.

## Usage

```sh
GITHUB_TOKEN=... node dist/bin.js <owner>/<repo> --agent <login> --agent-app <slug>
```

| Option | Meaning |
|---|---|
| `--agent <login>` | A user account an agent works as. Repeatable. |
| `--agent-app <slug>` | A GitHub App an agent works as, by slug or as `slug=id`. Give the id for a private App, which the token Darz reads with may not be able to look up. Repeatable. |
| `--gate <glob>` | Another gate-file pattern, for example `Makefile`. Repeatable. |
| `--merges <n>` | How many merged pull requests check 6 reads. Default 50. |
| `--out <dir>` | Where the outputs go. Default `./darz-out`. |
| `--api-url <url>` | The API base URL. Default `https://api.github.com`. No other host is called. |
| `--token-env <name>` | The environment variable that holds the token. Default `GITHUB_TOKEN`. |
| `--ref <sha>` | The commit check 7 runs lessons over, as a full commit SHA. Default: the default branch's head. Lessons are always read from the head, and every other check reads the head. |
| `--graphql-ruleset-roles` | Also read ruleset bypass role names with GitHub's GraphQL API (read-only queries sent as POST), so check 4 can decide role-based bypasses. Off by default. `=true` and `=false` are also accepted. |

Agents can also be declared in the repository, at `.github/darz.json` on the default branch:

```json
{ "agents": ["coder-agent"], "agentApps": [{ "slug": "my-agent-app", "id": 123456 }], "gates": ["Makefile"] }
```

Darz also detects agent identities itself: any account whose type is `Bot`, or whose login ends in `[bot]`, found in the collaborators list, the ruleset bypass actors, CODEOWNERS, or the authors of recent merges. `github-actions[bot]`, the identity every workflow's token acts as, is a platform identity: it is detected only as a ruleset bypass actor, or when declared.

Darz is read-only:

- It sends GET requests only. Its client refuses any other method before anything is sent. The one exception is opt-in: `--graphql-ruleset-roles` sends compiled, read-only GraphQL queries, which travel as POST requests, to read ruleset bypass role names. It is off by default, runs only when a ruleset has a repository-role bypass and an agent holds a repository permission, and the record lists it when it runs.
- It follows a redirect only to the API URL itself, as GitHub sends for a renamed or transferred repository, and lists the redirect in the record. A redirect to any other host or path is not followed. See [`docs/checks.md`](docs/checks.md#redirects).
- It never prints, logs or writes the token.

## GitHub Action

Darz also runs as a GitHub Action, listed on the Marketplace as **DARZ Agent Gate Check**: a Marketplace name cannot match a GitHub user or organization, and a user named darz exists. It reads the repository over the API and never checks out or runs its code. It makes no write call to any API: it writes the record and the SARIF file to `out-dir`, sets step outputs, and adds a job summary. To show results in code scanning, upload `darz.sarif` in a separate step, as below. That step is the only one that writes, and it needs `security-events: write`.

Pin the Action to the full commit SHA of a release, not to a tag: a tag can move, a commit cannot.

```yaml
name: darz
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 6 * * 1"

permissions:
  contents: read

jobs:
  darz:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      security-events: write
    steps:
      - id: darz
        uses: BargLabs/darz@<full commit SHA of a release>
        with:
          agent-apps: my-agent-app
          token: ${{ secrets.DARZ_TOKEN }}
      - uses: github/codeql-action/upload-sarif@1bd86f2fdb4b86187fa4059f16f31a3202acc9ea
        if: always()
        with:
          sarif_file: ${{ steps.darz.outputs.sarif }}
          category: darz
```

| Input | Default | Meaning |
|---|---|---|
| `repository` | the workflow's repository | The repository to check, as `owner/name`. |
| `token` | the workflow token | The token Darz reads with. See below. |
| `agents`, `agent-apps`, `gates` | none | As `--agent`, `--agent-app` and `--gate`. Separate entries with commas or new lines. |
| `merges` | `50` | Merged pull requests check 6 reads. |
| `out-dir` | `darz-out` | Where the record and SARIF are written. Darz's own files there from an earlier run are removed first, so a run that stops early never reports them. |
| `api-url` | the workflow's API URL | No other host is called. |
| `graphql-ruleset-roles` | `false` | `true` turns on the opt-in GraphQL reader described above. Read in any case, so `True` works too. |
| `fail-on` | `fail` | `fail` fails the step when a check fails. `unverifiable` also fails it when a row is unverifiable. `never` only reports. An unreadable repository always fails the step. |

**Outputs:**
- `exit-code`;
- `record`, `record-sha256` and `sarif`, the file paths and the record's SHA-256;
- `pass`, `fail` and `unverifiable`, the counts.

**The default workflow token reads less than a full check needs.** Give the job `pull-requests: read`, or check 6 cannot read merged pull requests. Even then, the workflow token cannot read classic branch protection, ruleset bypass lists or the collaborators list. The rows that depend on them come out `unverifiable`, the step does not fail, and the job summary says what to add: a token with Administration: read, such as a fine-grained token or a GitHub App installation token, passed as `token` from a secret. Check 4 also reads the installation permissions of agent apps, which needs an organisation owner's token or organisation Administration: read. Without it, check 4 says in its context that they were not checked, and decides the row as before.

On a branch protected only by rulesets, one more thing applies. GitHub answers 404 for classic protection both when there is none and when the token may not read it. Darz takes that 404 as proof of absence only from a classic token with the `repo` scope belonging to an admin, because only such a token says what it may read, in its `x-oauth-scopes` header. A fine-grained or app token leaves classic protection unverifiable on such a branch. A classic `repo` token can also write, so weigh that before storing one as a secret. Darz itself only reads.

## What it checks

| # | Check | Passes when |
|---|---|---|
| 1 | `gate_files_owned` | Every gate file has a code owner, and code-owner review is required. Gate files are CI workflows and actions, the CODEOWNERS file in use, test and coverage configuration, `.github/darz.json`, and lesson files in `.github/darz/lessons/`. `package.json`, `vite.config.*`, `pyproject.toml` and `setup.cfg` count only when they hold test or coverage settings. A new workflow, a new action, and a CODEOWNERS file in a location GitHub reads first must have an owner too. |
| 2 | `human_review_required` | At least one approving review is required, stale approvals are dismissed on push, and the most recent push must be approved by someone other than its pusher. |
| 3 | `writer_not_approver` | The last-push rule holds, and no agent identity is a code owner of a gate file. |
| 4 | `agents_cannot_bypass` | No agent identity can bypass a ruleset, holds admin permission, or is allowed to bypass classic pull request requirements. |
| 5 | `required_checks_fail_closed` | At least one status check is required before merging, and every required check is pinned to the app that must report it (none to an agent app). An unpinned check can be satisfied by anyone who can post a status with that name. |
| 6 | `agent_merges_touching_gates` | Context only, never pass or fail. For each recent merge by an agent identity: the gate files it changed, who approved it, and a link. |
| 7 | `lessons_hold` | Every lesson on the default branch was approved by a person other than its author and not an agent, and every lesson in force holds at the commit read. With no lesson in force the row is context, never pass. See [Lessons](#lessons). |

Each check reads both the branch's effective rules (rulesets, the organisation's included) and classic branch protection. [`docs/checks.md`](docs/checks.md) gives every reason a check can give, and how Darz reads CODEOWNERS, rulesets and classic protection.

## Lessons

A team that sees an agent make the same mistake twice can write it down as a lesson: a statement, the evidence, and a check Darz runs. Each lesson is one file at `.github/darz/lessons/<id>.json` on the default branch, described by [`schema/lesson-0.1.schema.json`](schema/lesson-0.1.schema.json):

```json
{
  "id": "no-focused-tests",
  "statement": "A test file never commits a focused test, which would skip every other test in the file.",
  "evidence": [{ "kind": "pull_request", "ref": "12" }],
  "check": {
    "kind": "forbid",
    "paths": ["test/**/*.test.ts"],
    "pattern": "\\b(?:it|describe|test)\\.only\\(",
    "match": "regex"
  }
}
```

`forbid` means no line in a matching file may match the pattern. `require` means every matching file must have a matching line, and at least one file must match. A lesson can be retired with `"retired": { "on": "YYYY-MM-DD", "reason": "..." }`.

A lesson takes effect only when the latest change to its file was approved, on the pull request's final commit, by a person who is neither the pull request's author nor an agent. Otherwise an agent could write, loosen or retire the lesson that judges it, so a lesson changed without that approval fails check 7 instead of being dropped.

Lesson files are gate files, so check 1 requires them to have a code owner. Check 7 always reads them from the default branch, even when `--ref` points at another commit, so a pull request cannot delete the lesson that judges it. See [`docs/checks.md`](docs/checks.md#7-lessons_hold).

## What `unverifiable` means

`unverifiable` means Darz could not decide. A read was refused or failed, or a field it needs was missing from a response. The row's reasons name what was missing. Darz never treats a setting it cannot read as met, and never fails a check because something is absent.

**A token without repository administration read cannot see some settings, so those rows will be `unverifiable`.** In particular:

- Classic branch protection needs administration read. GitHub answers 404 both when there is none and when the token may not read it, so Darz treats a 404 as unreadable. Only a branch that reports `protected: false` shows there is no classic protection.
- A ruleset's bypass list needs write access to the ruleset.
- The collaborators list needs push access.

On a public repository you do not administer, expect checks 1 to 4 to be `unverifiable` whenever they depend on those settings.

If no agent identity is declared or detected, checks 3, 4 and 6 are `unverifiable` with reason `no_agent_identities`, and so is check 5 when a required check is pinned to an app. They never pass on an empty set.

## Use alongside other checks

Darz asks one question: can a coding agent change, approve, bypass or report on the gate that reviews its own work? Other checks ask different questions. Run them side by side as independent signals; none of them answers Darz's question, and Darz does not answer theirs.

| Tool | What it asks | Overlap with Darz |
|---|---|---|
| Darz | Can an agent identity own the gate files, approve its own change, bypass the rules, or report a required check? | — |
| [OpenSSF Scorecard](https://github.com/ossf/scorecard) | How closely does the project follow supply-chain practices: branch protection, code review, token permissions, pinned dependencies, and more? | Branch protection and review. Scorecard scores the repository's settings as a whole. It does not know which accounts are agents, and its code-review check gives no score when every recent change was made by a bot. |
| [zizmor](https://github.com/zizmorcore/zizmor) | Can a workflow be exploited: template injection, excessive permissions, dangerous triggers, unpinned actions? | None directly. A workflow flaw is a way around the gate that does not go through the merge rules, so it complements check 1. |
| [OSV-Scanner](https://github.com/google/osv-scanner) | Do the dependencies have known vulnerabilities? | None. |

Each tool writes SARIF. Give each upload its own `category`, so code scanning keeps their alerts apart. A sketch for the first three, each job with only the permissions it needs. Uploading SARIF needs `security-events: write`, and in a private repository also `actions: read`:

```yaml
name: gate and supply-chain checks

on:
  push:
    branches: [main]
  schedule:
    - cron: "17 6 * * 1"

permissions: {}

jobs:
  darz:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      pull-requests: read
      security-events: write
    steps:
      - id: darz
        uses: BargLabs/darz@<full commit SHA of a release>
        with:
          # Name the accounts your agents work as. Without them,
          # checks 3, 4 and 6 are unverifiable, and the job still passes.
          agent-apps: my-agent-app
          token: ${{ secrets.DARZ_TOKEN }}
      - uses: github/codeql-action/upload-sarif@1bd86f2fdb4b86187fa4059f16f31a3202acc9ea
        if: always()
        with:
          sarif_file: ${{ steps.darz.outputs.sarif }}
          category: darz

  scorecard:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: ossf/scorecard-action@fa7117db83c52d787ae5a89f350999701505d78e # v2.5.0
        with:
          results_file: scorecard.sarif
          results_format: sarif
          # Optional: a token with Administration: read lets Scorecard read
          # more of the branch protection. Without it, the workflow token is used.
          # repo_token: ${{ secrets.SCORECARD_TOKEN }}
      - uses: github/codeql-action/upload-sarif@1bd86f2fdb4b86187fa4059f16f31a3202acc9ea
        with:
          sarif_file: scorecard.sarif
          category: scorecard

  zizmor:
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      # Uploads its own SARIF to code scanning by default.
      - uses: zizmorcore/zizmor-action@45d7276c9ca790aabd705e31ca99c6185c3e76dd # v0.8.1
        with:
          version: 1.32.0
```

Like Darz, Scorecard reads more of the branch protection with a token that has Administration: read. To give it one, store the token as a secret, `SCORECARD_TOKEN` in the sketch, and uncomment `repo_token`. Where a setting cannot be read, Darz reports the row `unverifiable` rather than scoring it.

A commit pin fixes an action's own files, not everything it runs. zizmor-action installs zizmor from hash-pinned lock files in its own tree; `version` names the release explicitly. scorecard-action is a Docker action, and at v2.5.0 it runs the image `ghcr.io/ossf/scorecard-action:v2.5.0` by tag, so the image can change under the same commit.

## Outputs

Darz writes three files to `--out`:

- **`darz-record.json`:** everything read and found, as [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON. That includes the format (`darz-record-0.3`), the tool version, the repository, the default branch, the commit SHA read, the commit check 7 ran lessons over (`ref`), `readAt` in UTC, the options used, which endpoints returned `read`, `not_permitted` or `error`, the agent identities, and every check row. It validates against [`schema/record-0.3.schema.json`](schema/record-0.3.schema.json). Format 0.3 adds check 7 and `ref`. Records from v0.2.0 are format 0.2 and validate against [`schema/record-0.2.schema.json`](schema/record-0.2.schema.json); records from v0.1.0 are format 0.1 and validate against [`schema/record-0.1.schema.json`](schema/record-0.1.schema.json). Both are kept as released.
- **`darz-record.json.sha256`:** the SHA-256 of those exact bytes, in `sha256sum` format.
- **`darz.sarif`:** SARIF 2.1.0, with one result per `fail` (level `error`) or `unverifiable` (level `warning`) row and rule IDs `darz/<check id>`. Check 7 gives one result per failing or unverifiable lesson instead, located at the file and line a violated lesson found, or at the lesson file. For github.com, GitHub Enterprise Server (`--api-url https://<host>/api/v3`) and GHE.com it names the repository and commit it read; for any other API URL it leaves that out rather than guess. You can upload it to code scanning.

The terminal summary prints one line per check.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Every check passed. |
| `1` | At least one check failed. |
| `2` | No check failed, but at least one is unverifiable. |
| `3` | The repository itself could not be read. |

An unverifiable row never exits `0`. A usage error exits `64`, and an internal error exits `70`.

## Why "Darz"

Darz (درز) is Persian for "seam": the line where two parts meet. Here, the line between an agent's work and the gate that judges it.

## Licence

Apache-2.0. Built by [Barg Labs](https://barglabs.ai).
