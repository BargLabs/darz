# Darz checks (v0.1, GitHub)

Each check gives `pass`, `fail` or `unverifiable`. Check 6 gives `context` instead of pass or fail. Each row in the record also lists its reasons and the endpoints (`GET /path`) and repository files it read.

Rules that hold for every check:

- **Unverifiable is never pass.** If a check depends on a read that did not end in `read`, or on a field that is missing from a response that was read, the row is `unverifiable`. The reason names what was missing.
- **Absence is never fail.** A row fails only on a setting or file that Darz read and found wanting.
- **A definite failure wins.** If one part of a check fails on data Darz read, the row is `fail` even when another part of it is unverifiable.
- **Reads end in one of three states**, decided by status code and response fields, never by the wording of an error message:
  - `read`;
  - `not_permitted`: a 401 or 403, or a 404 on a settings endpoint of a repository that is otherwise readable;
  - `error`: anything else, including a rate-limit response: a 429, or a 401 or 403 that carries `retry-after` (a secondary rate limit) or `x-ratelimit-remaining: 0`.
- **Every list is read to its last page.** Darz follows the `Link` header. If any page fails, the whole list counts as unread.

## Sources of protection

GitHub enforces two sources together on the default branch. Darz reads both:

- the **effective rules**, `GET /repos/{owner}/{repo}/rules/branches/{branch}`. These come from every active ruleset, including the organisation's, and any token that can read the repository can read them;
- **classic branch protection**, `GET /repos/{owner}/{repo}/branches/{branch}/protection`. Reading it needs repository administration access:
  - If the branch reports `protected: false`, Darz does not read it, and there is no classic protection.
  - GitHub returns 404 both when there is no classic protection and when the token may not read it. The user's role (`permissions.admin` on `GET /repos/{owner}/{repo}`) does not say what the token itself may read, so on its own it never tells the two apart.
  - A classic OAuth or personal access token lists its scopes in the `x-oauth-scopes` response header. If that list includes `repo` (exactly `repo`; `public_repo` does not count) and the user is an admin, the token can read classic protection. A 404 then proves there is none (`classicProtection.basis`: `admin_token_with_repo_scope`). These are the only two ways Darz concludes that classic protection is absent.
  - Any other response that is not `read` means classic protection is unreadable. That includes a 404 for a fine-grained token or a GitHub App token, neither of which sends a scopes header.
  - So on a protected branch whose classic protection Darz cannot read, a setting the rules already require still passes, but a setting only classic protection could supply is `unverifiable`.

A setting counts as **required** if any source requires it, because GitHub applies them all. It counts as **not required** only if every source was read and none requires it.

GitHub leaves `required_pull_request_reviews` or `required_status_checks` out of a classic protection response when that protection is off. Darz therefore reads a missing object as "off". It likewise leaves `bypass_pull_request_allowances` out when there are no allowances (seen on a live repository, 23 Nov), so Darz reads a missing allowances object as "none". A missing field *inside* an object that is present is `field_missing`.

## Agent identities

- **Declared:**
  - `--agent <login>`, repeatable. A login that ends in `[bot]` is taken as an app.
  - `--agent-app <slug>` or `--agent-app <slug>=<app id>`, repeatable.
  - `.github/darz.json` at the default branch's head:

    ```json
    { "agents": [], "agentApps": ["some-app", { "slug": "agent-app", "id": 123 }], "gates": [] }
    ```

    An `agentApps` entry is a slug, or an object with `slug` and, optionally, `id`. The config is invalid if it has any other key, an `agents` or `gates` value that is not an array of strings, or an `agentApps` entry of another shape.
- **Detected:** any account whose type is `Bot`, or whose login ends in `[bot]`, found in:
  - the collaborators list;
  - a ruleset's `Integration` bypass actors;
  - CODEOWNERS entries;
  - the authors of the merged pull requests read for check 6.

Darz looks up each app slug with `GET /apps/{slug}` so that an app known by slug and an app known by ID count as one identity.
- **Slug does not resolve:** if a declared app's slug does not resolve (a 404 because it is misspelt, or a read that failed) and the declaration gives no id, checks 3, 4 and 6 are `unverifiable` with reason `agent_app_unresolved`. A check about an app that may not exist cannot pass.
- **Declare the id to avoid the lookup:** a private App may not be visible to the token Darz reads with. The GitHub Actions workflow token could not see one. Declare such an App with its id, and no lookup is needed.
- **Declared id and lookup disagree:** if the lookup does resolve and gives a different id, checks 3, 4 and 6 are `unverifiable` with reason `agent_app_id_mismatch`.

With no agent identities at all, checks 3, 4 and 6 also report `config_invalid` or `config_unreadable` when `.github/darz.json` could not be used.

An empty `--agent` or `--agent-app` value, in either the `--agent <login>` or the `--agent=<login>` form, is a usage error (exit code 64). The record lists each identity with its source: `declared` (which wins if an identity is also detected) or `detected`, and where it was found.

If there are no agent identities, checks 3, 4 and 6 are `unverifiable` with reason `no_agent_identities`. They never pass on an empty set.

## Gate files

Gate files are the paths in the default branch's tree that match any of these:

- **CI and actions:** `.github/workflows/**`, `.github/actions/**`.
- **The CODEOWNERS file in use**, and Darz's own config, `.github/darz.json`.
- **Test configuration:** `**/jest.config.*`, `**/vitest.config.*`, `**/vitest.workspace.*`, `**/playwright.config.*`, `**/karma.conf.*`, `**/.mocharc*`, `**/pytest.ini`, `**/tox.ini`, `**/noxfile.py`, `**/conftest.py`, `**/phpunit.xml*`.
- **Coverage:** `**/.nycrc*`, `**/codecov.yml`, `**/.codecov.yml`, `**/.coveragerc`, `**/sonar-project.properties`.
- **Files that hold test or coverage settings.** Darz reads every `**/package.json`, `**/vite.config.*`, `**/pyproject.toml` and `**/setup.cfg` in the tree (`GET /repos/{owner}/{repo}/git/blobs/{sha}`, at most 200) and counts one as a gate file only when it configures tests:
  - `package.json`: a script named `test` or `coverage`, or one that starts with either followed by `:`, `.`, `_` or `-` (`test:unit`, `coverage-ci`); or a `jest`, `nyc`, `c8`, `vitest`, `mocha`, `ava` or `tap` block;
  - `vite.config.*`: a `test:` key (Vitest's inline configuration);
  - `pyproject.toml`: a `[tool.pytest...]` or `[tool.coverage...]` table;
  - `setup.cfg`: a `[tool:pytest]` or `[coverage:...]` section.

  The rest are listed in check 1's `details.candidatesWithoutTestSettings` as context. That way, a dependency bump in a `package.json` with no test settings is not a gate change. A candidate that cannot be read or parsed gives `gate_candidate_unreadable`. More than 200 candidates gives `gate_candidates_over_cap`. Both leave the inventory incomplete, so checks 1 and 3 are `unverifiable` unless they already fail.
- **Your own patterns**, from any `--gate <glob>` or the config's `gates`.

In these globs, `**/` matches any number of directories (including none), `*` matches within one path segment, and `?` matches one character.

For check 6, a change to any of GitHub's three CODEOWNERS locations counts as a gate change. Adding a CODEOWNERS file in a location GitHub checks earlier replaces the one in use.

## CODEOWNERS

- **Which file:** GitHub uses the first of `.github/CODEOWNERS`, `CODEOWNERS` and `docs/CODEOWNERS` that exists. Darz looks for each in that order with `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}`.
- **Pattern syntax:** gitignore syntax, as GitHub documents it:
  - Patterns are relative to the repository root and case sensitive.
  - A pattern with no slash, or only a trailing one, matches at any depth.
  - A trailing `/` matches the contents of a directory.
  - A pattern whose last segment contains `*` matches files only. For example, `docs/*` does not own `docs/a/b.md`.
- **Which line applies:** the last matching line wins. A line with a pattern and no owners leaves the path unowned.
- **Lines GitHub reports as errors:** Darz reads `GET /repos/{owner}/{repo}/codeowners/errors` and reports each such line.
  - **Every owner on the line is an unknown owner** (kind `Unknown owner`, with a `column` at each owner): GitHub still applies the line, and the paths it matches have no code owner. GitHub does not fall back to an earlier line. This was verified on 23 Nov in a scratch repository: a path matched last by such a line showed no code owner, while a path matched only by the earlier `* @owner` line showed one.
  - **Any other case** is not verified: another error kind, a line where only some owners are flagged, or an error with no `column`. The flagged line gives no owner, and if an earlier line would own the path, the path is `codeowners_error_ambiguous`.
- **Team and email owners** are reported as written. Their members are not read.

## 1. `gate_files_owned`

- **Reads:** the tree at the default branch's head (`GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`, with that SHA recorded), the CODEOWNERS file in use, `codeowners/errors`, the rules, and classic protection.
- **`pass`:** every gate file has at least one owner, and the default branch requires code-owner review.
- **`fail`:**
  - `gate_files_unowned`, listing the files;
  - `code_owner_review_not_required`;
  - `no_codeowners_file`, given when the tree has no gate files and no CODEOWNERS file.
- **`unverifiable`:**
  - `tree_unreadable`;
  - `tree_truncated`: GitHub truncated the tree, so the inventory is incomplete;
  - `codeowners_unreadable`;
  - `codeowners_errors_unreadable`;
  - `codeowners_error_ambiguous`;
  - `config_invalid` or `config_unreadable`;
  - `rules_unreadable`, `classic_protection_unreadable` or `field_missing`, for the code-owner review setting.

## 2. `human_review_required`

- **Reads:** the rules and classic protection.
- **`pass`:** the sources together require all of these:
  - at least one approving review;
  - stale approvals dismissed on push;
  - approval of the most recent push by someone other than its pusher.
- **`fail`:**
  - `no_pull_request_rule`;
  - one reason for each missing setting: `approving_review_not_required`, `stale_reviews_not_dismissed`, `last_push_approval_not_required`.
- **`unverifiable`:**
  - `rules_unreadable`;
  - `classic_protection_unreadable`: for example, the branch is protected, there are no rules, and classic protection cannot be read;
  - `field_missing`.

## 3. `writer_not_approver`

- **`pass`:** approval of the most recent push by someone else is required, and no agent identity is a code owner of any gate file.
- **`fail`:**
  - `agent_is_code_owner`, naming the identity and the files;
  - `last_push_approval_not_required`.
- **`unverifiable`:**
  - `no_agent_identities`;
  - the tree and CODEOWNERS reasons from check 1;
  - `unresolved_owners`: a gate file is owned by a team or an email address, and a declared user agent could be behind it (an app's bot account cannot be);
  - `agent_app_unresolved`: a declared agent app's slug did not resolve, and no id was declared;
  - `agent_app_id_mismatch`: the declared id and GitHub's id for the slug differ;
  - the reasons for an unreadable source.
- **Context:** GitHub never counts a pull request author's own approval toward required reviews. That is GitHub's behaviour, not this check.

## 4. `agents_cannot_bypass`

- **Reads:**
  - every ruleset in effect on the default branch, including organisation rulesets, with `GET /repos/{owner}/{repo}/rulesets/{id}?includes_parents=true`, taking the IDs from the effective rules;
  - the collaborators list;
  - classic protection.
- **`fail`:**
  - `agent_app_can_bypass`: an `Integration` bypass actor. Every app that can bypass is treated as an agent app.
  - `agent_role_can_bypass`: an `OrganizationAdmin` bypass covers an agent identity with admin permission, taken from the collaborators list.
  - `agent_is_admin`: an agent identity has admin permission.
  - `admins_not_enforced_agent_is_admin`: classic protection has `enforce_admins` false and an agent identity is an admin.
  - `agent_in_bypass_allowance`: classic protection's `bypass_pull_request_allowances` names an agent identity.
- **`unverifiable`:**
  - `no_agent_identities`;
  - `rules_unreadable`;
  - `ruleset_unreadable`;
  - `bypass_list_unreadable`: a ruleset response has no `bypass_actors`. GitHub includes them only for tokens with write access to the ruleset;
  - `bypass_role_unknown`: a `RepositoryRole` bypass, while an agent identity holds a repository permission. GitHub does not document which `actor_id` is which built-in repository role: the REST reference says only that `actor_id` is required for `RepositoryRole`. So Darz cannot tell whether the role covers the agent, and the row cannot pass. Apps that are not collaborators hold no repository role, so they leave the row decidable. An agent with admin permission still fails as `agent_is_admin`;
  - `bypass_actor_unknown`;
  - `team_bypass_members_unread`: a team can bypass and a declared user agent could be a member;
  - `collaborators_unreadable`;
  - `classic_protection_unreadable`;
  - `field_missing`;
  - `agent_app_unresolved` or `agent_app_id_mismatch`;
  - `config_invalid` or `config_unreadable`.
- **Context:** GitHub App installation permissions, such as `administration: write`, cannot be read with a user token and are not checked. Deploy-key bypasses are listed.

## 5. `required_checks_fail_closed`

- **Reads:** the rules and classic protection.
- **`pass`:** at least one status check is required, every required check is pinned to the app that must report it, and none is pinned to an agent app.
  - A required check that is not pinned can be satisfied by anyone who can post a commit status or check run with that name, an agent included. So it does not fail closed.
  - The rules carry the pin as `required_status_checks[].integration_id`; GitHub leaves the field out when any source may report the check.
  - Classic protection carries it as `required_status_checks.checks[].app_id`, which is `null` for any source. A legacy `contexts` list with no `checks` array pins nothing.
  - A check pinned by any source counts as pinned, because GitHub enforces every source.
- **`fail`:**
  - `no_required_checks`;
  - `required_check_unpinned`, naming the checks;
  - `required_check_pinned_to_agent_app`, naming the check and the app.
- **`unverifiable`:** `rules_unreadable`, `classic_protection_unreadable` or `field_missing`. A source Darz could not read could pin a check or require another one, so with a source unreadable the row is never a pass. An unpinned check is not a fail while a source that could pin it is unreadable.
- **Context (`details`):** each required check with the app ids it is pinned to (empty for any source), and whether the branch must be up to date before merging (`true`, `false` or `"unknown"`).
- **Note:** a check pinned to GitHub Actions is produced by a workflow. Whether an agent can change that workflow is what check 1 answers.

## 6. `agent_merges_touching_gates`

This check is context: it never passes or fails.

- **Reads:**
  - closed pull requests into the default branch, newest update first (`GET /repos/{owner}/{repo}/pulls?state=closed&base={branch}&sort=updated&direction=desc`), page by page, until it has `--merges` merged ones (default 50). It then keeps the N most recently merged;
  - for each pull request by an agent identity: its file list and its reviews, every page of each.
- **Details:**
  - for each agent pull request: its number, link, author, merge time, the gate files it changed, and its approvers. An approver is a reviewer whose latest review that sets a state is `APPROVED`; `COMMENTED` and `PENDING` reviews do not set a state;
  - counts of agent merges, and of agent merges that touched gate files.

  It gives counts and links only, with no judgement of intent. If fewer than N merged pull requests exist, the row says how many were read.

  GitHub's file list for a pull request stops at 3,000 files without saying so. A list that reaches 3,000 is treated as possibly cut off: the pull request is marked `fileListTruncated: true`, its gate files are a lower bound, and the row is `unverifiable`.
- **`unverifiable`:**
  - `no_agent_identities`;
  - `merges_unreadable`;
  - `pull_request_files_unreadable`;
  - `pull_request_files_truncated`;
  - `pull_request_reviews_unreadable`;
  - `agent_app_unresolved` or `agent_app_id_mismatch`;
  - `config_invalid` or `config_unreadable`.

## All reasons

| Reason | Status | Checks | Meaning |
|---|---|---|---|
| `repository_unreadable` | unverifiable | all | The repository itself could not be read (exit code 3). |
| `no_agent_identities` | unverifiable | 3, 4, 6 | No agent identity was declared or detected. |
| `config_invalid` | unverifiable | 1, 3, 4, 6 | `.github/darz.json` exists but is not valid. |
| `config_unreadable` | unverifiable | 1, 3, 4, 6 | `.github/darz.json` could not be read. |
| `field_missing` | unverifiable | 1-5 | A field the check needs is missing from a response that was read; the subjects name it. |
| `rules_unreadable` | unverifiable | 1-5 | The effective rules could not be read. |
| `classic_protection_unreadable` | unverifiable | 1-5 | The branch is protected and classic protection could not be read. |
| `tree_unreadable` | unverifiable | 1, 3 | The tree could not be read. |
| `tree_truncated` | unverifiable | 1, 3 | GitHub truncated the tree. |
| `codeowners_unreadable` | unverifiable | 1, 3 | A CODEOWNERS file could not be read. |
| `codeowners_errors_unreadable` | unverifiable | 1, 3 | `codeowners/errors` could not be read. |
| `codeowners_error_ambiguous` | unverifiable | 1, 3 | A reported CODEOWNERS line, of a kind whose handling is not verified, is the last match over an earlier owner. |
| `gate_files_unowned` | fail | 1 | Gate files with no code owner. |
| `no_codeowners_file` | fail | 1 | No CODEOWNERS file and no gate files. |
| `code_owner_review_not_required` | fail | 1 | Code-owner review is not required. |
| `no_pull_request_rule` | fail | 2 | No source requires a pull request. |
| `approving_review_not_required` | fail | 2 | No approving review is required. |
| `stale_reviews_not_dismissed` | fail | 2 | Stale approvals are kept on push. |
| `last_push_approval_not_required` | fail | 2, 3 | Approval of the last push by someone else is not required. |
| `agent_is_code_owner` | fail | 3 | An agent identity owns gate files. |
| `unresolved_owners` | unverifiable | 3 | Team or email owners of gate files, with a declared user agent. |
| `agent_app_unresolved` | unverifiable | 3, 4, 6 | A declared agent app's slug did not resolve with `GET /apps/{slug}`, and no id was declared. |
| `agent_app_id_mismatch` | unverifiable | 3, 4, 6 | A declared agent app's id differs from GitHub's id for its slug. |
| `agent_app_can_bypass` | fail | 4 | An app is a ruleset bypass actor. |
| `agent_role_can_bypass` | fail | 4 | A role bypass covers an agent identity. |
| `agent_is_admin` | fail | 4 | An agent identity is an admin. |
| `admins_not_enforced_agent_is_admin` | fail | 4 | `enforce_admins` is off and an agent identity is an admin. |
| `agent_in_bypass_allowance` | fail | 4 | Classic protection lets an agent identity bypass pull request requirements. |
| `ruleset_unreadable` | unverifiable | 4 | A ruleset in effect could not be read. |
| `bypass_list_unreadable` | unverifiable | 4 | A ruleset response has no `bypass_actors`. |
| `bypass_role_unknown` | unverifiable | 4 | A repository-role bypass, while an agent holds a repository permission; GitHub does not document role ids. |
| `bypass_actor_unknown` | unverifiable | 4 | A bypass names an unknown actor type. |
| `team_bypass_members_unread` | unverifiable | 4 | A team can bypass and a declared user agent could be a member. |
| `collaborators_unreadable` | unverifiable | 4 | The collaborators list could not be read. |
| `no_required_checks` | fail | 5 | No status check is required. |
| `required_check_unpinned` | fail | 5 | A required check is not pinned to the app that must report it. |
| `required_check_pinned_to_agent_app` | fail | 5 | A required check is pinned to an agent app. |
| `gate_candidate_unreadable` | unverifiable | 1, 3 | A candidate file could not be read or parsed. |
| `gate_candidates_over_cap` | unverifiable | 1, 3 | More than 200 candidate files. |
| `merges_unreadable` | unverifiable | 6 | Merged pull requests could not be read. |
| `pull_request_files_unreadable` | unverifiable | 6 | An agent pull request's file list could not be read. |
| `pull_request_files_truncated` | unverifiable | 6 | An agent pull request's file list reached GitHub's 3,000-file limit. |
| `pull_request_reviews_unreadable` | unverifiable | 6 | An agent pull request's reviews could not be read. |
