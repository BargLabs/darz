# Darz

Darz checks whether a repository stops AI coding agents from changing the rules that judge their work.

An agent has no gate if it can do any of these:

- edit its own CI;
- loosen its own tests;
- approve its own pull request;
- merge its own pull request.

Darz reads a repository's settings and files and reports `pass`, `fail` or `unverifiable` for each check, with the setting or file it read. It fails closed when it cannot decide, uses no AI model, and writes a record anyone can re-run.

**Status: v0.2.0, early. GitHub only. Use the GitHub Action pinned to a release's full commit SHA, or install from source.**

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
| `--graphql-ruleset-roles` | Also read ruleset bypass role names with GitHub's GraphQL API (read-only queries sent as POST), so check 4 can decide role-based bypasses. Off by default. `=true` and `=false` are also accepted. |

Agents can also be declared in the repository, at `.github/darz.json` on the default branch:

```json
{ "agents": ["coder-agent"], "agentApps": [{ "slug": "my-agent-app", "id": 123456 }], "gates": ["Makefile"] }
```

Darz also detects agent identities itself: any account whose type is `Bot`, or whose login ends in `[bot]`, found in the collaborators list, the ruleset bypass actors, CODEOWNERS, or the authors of recent merges.

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
| 1 | `gate_files_owned` | Every gate file has a code owner, and code-owner review is required. Gate files are CI workflows and actions, the CODEOWNERS file in use, test and coverage configuration, and `.github/darz.json`. `package.json`, `vite.config.*`, `pyproject.toml` and `setup.cfg` count only when they hold test or coverage settings. A new workflow, a new action, and a CODEOWNERS file in a location GitHub reads first must have an owner too. |
| 2 | `human_review_required` | At least one approving review is required, stale approvals are dismissed on push, and the most recent push must be approved by someone other than its pusher. |
| 3 | `writer_not_approver` | The last-push rule holds, and no agent identity is a code owner of a gate file. |
| 4 | `agents_cannot_bypass` | No agent identity can bypass a ruleset, holds admin permission, or is allowed to bypass classic pull request requirements. |
| 5 | `required_checks_fail_closed` | At least one status check is required before merging, and every required check is pinned to the app that must report it (none to an agent app). An unpinned check can be satisfied by anyone who can post a status with that name. |
| 6 | `agent_merges_touching_gates` | Context only, never pass or fail. For each recent merge by an agent identity: the gate files it changed, who approved it, and a link. |

Each check reads both the branch's effective rules (rulesets, the organisation's included) and classic branch protection. [`docs/checks.md`](docs/checks.md) gives every reason a check can give, and how Darz reads CODEOWNERS, rulesets and classic protection.

## What `unverifiable` means

`unverifiable` means Darz could not decide. A read was refused or failed, or a field it needs was missing from a response. The row's reasons name what was missing. Darz never treats a setting it cannot read as met, and never fails a check because something is absent.

**A token without repository administration read cannot see some settings, so those rows will be `unverifiable`.** In particular:

- Classic branch protection needs administration read. GitHub answers 404 both when there is none and when the token may not read it, so Darz treats a 404 as unreadable. Only a branch that reports `protected: false` shows there is no classic protection.
- A ruleset's bypass list needs write access to the ruleset.
- The collaborators list needs push access.

On a public repository you do not administer, expect checks 1 to 4 to be `unverifiable` whenever they depend on those settings.

If no agent identity is declared or detected, checks 3, 4 and 6 are `unverifiable` with reason `no_agent_identities`, and so is check 5 when a required check is pinned to an app. They never pass on an empty set.

## Outputs

Darz writes three files to `--out`:

- **`darz-record.json`:** everything read and found, as [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) canonical JSON. That includes the format (`darz-record-0.2`), the tool version, the repository, the default branch, the commit SHA read, `readAt` in UTC, the options used, which endpoints returned `read`, `not_permitted` or `error`, the agent identities, and every check row. It validates against [`schema/record-0.2.schema.json`](schema/record-0.2.schema.json). Format 0.2 adds the GraphQL reader's option and reads; records from v0.1.0 are format 0.1 and validate against [`schema/record-0.1.schema.json`](schema/record-0.1.schema.json), which is kept as released.
- **`darz-record.json.sha256`:** the SHA-256 of those exact bytes, in `sha256sum` format.
- **`darz.sarif`:** SARIF 2.1.0, with one result per `fail` (level `error`) or `unverifiable` (level `warning`) row and rule IDs `darz/<check id>`. For github.com, GitHub Enterprise Server (`--api-url https://<host>/api/v3`) and GHE.com it names the repository and commit it read; for any other API URL it leaves that out rather than guess. You can upload it to code scanning.

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
