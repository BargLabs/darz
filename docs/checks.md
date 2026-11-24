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
- **Redirects are followed only within the API URL.** See below.

## Redirects

GitHub answers a read of a renamed or transferred repository with a 301 whose `Location` is `/repositories/{id}/...` on the same API host. For example, `GET /repos/vuejs/vue-next` answers 301 to `https://api.github.com/repositories/137078487` (seen live, 23 Nov), and so does every path under it, with its query string kept.

Darz follows a 301, 302, 303, 307 or 308 as a GET only when the `Location` is on the API URL's origin (same scheme, host and port), carries no user name or password, and lies under the API URL's path (`/api/v3` on GitHub Enterprise Server). A relative `Location` is resolved against the URL that answered. It follows at most 3 redirects per request. Otherwise the read is an `error`, with the redirect's status and one of these kinds, and the `Location` is never called:

- `foreign_redirect`: the `Location` is outside the API URL;
- `redirect_without_location`: the response has no `Location`;
- `redirect_limit`: a fourth redirect.

The record lists each URL a redirect sent Darz to as its own entry, with the status that URL answered. The path Darz asked for keeps its entry and the page count, with the status it answered, so a 3xx there says the read was redirected. All these entries carry how the read ended (`state`, and `absent` or `errorKind` if any). A check's row lists the path Darz asked for, so the entry it names says whether the read succeeded. For a renamed repository, `GET /repos/{old owner}/{old name}` has status 301, and `GET /repositories/{id}` beside it has the status of the answer that was used. `repository` in the record stays the name Darz was given.

The opt-in GraphQL read does not follow redirects. GitHub's GraphQL API resolves a renamed repository by its old name itself.

## Sources of protection

GitHub enforces two sources together on the default branch. Darz reads both:

- the **effective rules**, `GET /repos/{owner}/{repo}/rules/branches/{branch}`. These come from every active ruleset, including the organisation's, and any token that can read the repository can read them;
- **classic branch protection**, `GET /repos/{owner}/{repo}/branches/{branch}/protection`. Reading it needs repository administration access:
  - If the branch reports `protected: false`, Darz does not read it, and there is no classic protection.
  - GitHub returns 404 both when there is no classic protection and when the token may not read it. The user's role (`permissions.admin` on `GET /repos/{owner}/{repo}`) does not say what the token itself may read, so on its own it never tells the two apart.
  - A classic OAuth or personal access token lists its scopes in the `x-oauth-scopes` response header. If that list includes `repo` (exactly `repo`; `public_repo` does not count) and the user is an admin, the token can read classic protection. If the branch was also read as protected, a 404 then proves there is none (`classicProtection.basis`: `admin_token_with_repo_scope`). These are the only two ways Darz concludes that classic protection is absent.
  - Two answers contradict a 404, so with either one it stays unreadable: the branch itself could not be read (GitHub also answers 404 for a branch it cannot find), or the branch is protected and its effective rules were read and are empty (a protected branch with no rules must have classic protection).
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
- **Slug does not resolve:** if a declared app's slug does not resolve (a 404 because it is misspelt, or a read that failed) and the declaration gives no id, checks 3, 4 and 6 are `unverifiable` with reason `agent_app_unresolved`, and so is check 5 when a required check is pinned to an app. A check about an app that may not exist cannot pass.
- **Declare the id to avoid the lookup:** a private App may not be visible to the token Darz reads with. The GitHub Actions workflow token could not see one. Declare such an App with its id, and no lookup is needed.
- **Declared id and lookup disagree:** if the lookup does resolve and gives a different id, checks 3, 4 and 6 are `unverifiable` with reason `agent_app_id_mismatch`, and so is check 5 when a required check is pinned to an app.
- **Declared id not confirmed:** if the lookup does not resolve (a 404, a 403, or a read that failed), the declared id is used, and checks 3, 4 and 6, and check 5 when a required check is pinned to an app, carry a context line saying the id is as declared and was not confirmed.
- **One slug, two ids:** if one app slug is declared with different ids, in `.github/darz.json`, in `--agent-app` flags or across both, checks 3, 4 and 6 are `unverifiable` with reason `agent_app_ids_conflict`, and so is check 5 when a required check is pinned to an app. Slugs are compared without case and without a `[bot]` suffix. The same slug declared twice with the same id, or once with an id and once without, is not a conflict.
- **Two slugs, one id:** if two different declared slugs have the same app id, declared or from the lookup, checks 3, 4 and 6 are `unverifiable` with reason `agent_app_slugs_share_id`, and so is check 5 when a required check is pinned to an app. One app has one slug, so at least one of the two is wrong. Darz keeps one identity for the id, with the slug declared first. If that is the wrong slug, the agent's real bot account (`<slug>[bot]`) matches no identity, and its pull requests and code ownership go unseen. A declared slug that shares an id with a detected app, such as an `Integration` bypass actor or a merge author, is not reported.

With no agent identities at all, checks 3, 4 and 6 also report `config_invalid` or `config_unreadable` when `.github/darz.json` could not be used.

An empty `--agent` or `--agent-app` value, in either the `--agent <login>` or the `--agent=<login>` form, is a usage error (exit code 64). The record lists each identity with its source: `declared` (which wins if an identity is also detected) or `detected`, and where it was found.

If there are no agent identities, checks 3, 4 and 6 are `unverifiable` with reason `no_agent_identities`. They never pass on an empty set. Check 5 is too when a required check is pinned to an app, since that app could be an agent's.

## Gate files

Gate files are the paths in the default branch's tree that match any of these:

- **CI and actions:** `.github/workflows/**`, `.github/actions/**`.
- **The CODEOWNERS file in use**, and Darz's own config, `.github/darz.json`.
- **Test configuration:** `**/jest.config.*`, `**/vitest.config.*`, `**/vitest.workspace.*`, `**/playwright.config.*`, `**/karma.conf.*`, `**/.mocharc*`, `**/pytest.ini`, `**/tox.ini`, `**/noxfile.py`, `**/conftest.py`, `**/phpunit.xml*`.
- **Coverage:** `**/.nycrc*`, `**/codecov.yml`, `**/.codecov.yml`, `**/.coveragerc`, `**/sonar-project.properties`.
- **Files that hold test or coverage settings.** Darz reads every `**/package.json`, `**/vite.config.*`, `**/pyproject.toml` and `**/setup.cfg` in the tree, outside `node_modules` (`GET /repos/{owner}/{repo}/git/blobs/{sha}`), and counts one as a gate file only when it configures tests:
  - `package.json`: a script named `test` or `coverage`, or one that starts with either followed by `:`, `.`, `_` or `-` (`test:unit`, `coverage-ci`); or a `jest`, `nyc`, `c8`, `vitest`, `mocha`, `ava` or `tap` block;
  - `vite.config.*`: a `test:` key, quoted or not (Vitest's inline configuration);
  - `pyproject.toml`: a `[tool.pytest...]` or `[tool.coverage...]` table;
  - `setup.cfg`: a `[tool:pytest]` or `[coverage:...]` section.

  Checks 1 and 3 judge these files at the default branch's head. Check 6 judges a changed one as it was at each merge (see check 6). The rest are listed in check 1's `details.candidatesWithoutTestSettings` as context. That way, a dependency bump in a `package.json` with no test settings is not a gate change. A candidate that cannot be read or parsed gives `gate_candidate_unreadable`.

  How many are read:
  - **Not under `node_modules`.** A file with a `node_modules` directory in its path is not a candidate. Package managers install dependencies there, and pytest, Jest and Vitest skip `node_modules` by default, so a dependency's settings are not the repository's. JavaScript actions often commit `node_modules`, with hundreds of `package.json` files.
  - **Each content once.** Files with the same blob SHA have the same content, so each blob is read once. Each path is still judged by its own name.
  - **At most 500 distinct files.** Each is one GET. A `GITHUB_TOKEN` in Actions gets 1,000 REST requests per hour per repository, and a run at the default settings makes about 50 to 150 other GETs (51 on this repository, with its agent pull requests). 500 leaves room for those, and stays under GitHub's secondary limit of 900 REST points a minute even if every read lands in the same minute. A personal access token or an App gets at least 5,000 an hour. These limits are from GitHub's [REST rate limits page](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

  More than 500 distinct candidate files gives `gate_candidates_over_cap`, naming the counts, and none is read. Like `gate_candidate_unreadable`, it leaves the inventory incomplete, so checks 1 and 3 are `unverifiable` unless they already fail.
- **Your own patterns**, from any `--gate <glob>` or the config's `gates`.

In these globs, `**/` matches any number of directories (including none), `*` matches within one path segment, and `?` matches one character.

For check 6, a change to any of GitHub's three CODEOWNERS locations counts as a gate change. Adding a CODEOWNERS file in a location GitHub checks earlier replaces the one in use.

### Probe paths: files that would change the gate if added

A gate can also change through a file that does not exist yet. Checks 1 and 3 judge the ownership of a synthetic probe path for each such case. A probe is a path, not a read: ownership under CODEOWNERS depends only on the path.

- **Each CODEOWNERS location GitHub reads before the file in use.** Adding a file there replaces the file in use. With the root `CODEOWNERS` in use, the probe is `.github/CODEOWNERS`. With `docs/CODEOWNERS` in use, the probes are `.github/CODEOWNERS` and `CODEOWNERS`. With `.github/CODEOWNERS` in use, there is none.
- **A new file in each gate directory:**
  - `.github/workflows/darz-probe-new-workflow.yml` and `.github/workflows/darz-probe-new-workflow.yaml` for `.github/workflows/**`. GitHub runs only workflow files directly in that directory, so the probes are there. It runs both extensions, so a CODEOWNERS that owns only `*.yml` leaves the `.yaml` probe unowned;
  - `.github/actions/darz-probe-new-action/action.yml` and `.github/actions/darz-probe-new-action/action.yaml` for `.github/actions/**`: a new local action, under either name GitHub reads;
  - for your own patterns (`--gate` or the config's `gates`), the pattern's literal leading directories, followed by its wildcard part with `**` segments dropped (or replaced by `darz-probe-new-file` when last), each `*` replaced by `darz-probe-new-file` and each `?` by `z`. For example, `ci/**` gives `ci/darz-probe-new-file`, and `scripts/*.sh` gives `scripts/darz-probe-new-file.sh`.

  A pattern with no wildcard names one file, and a pattern that starts with a wildcard (`**/conftest.py`) names files at any depth. Neither has a gate directory, so neither gets a probe. A new `conftest.py` in a new directory is owned only by a pattern that matches at any depth, such as `*` or `conftest.py`, and Darz does not probe for it.

Probe names start with `darz-probe-`. If a file with a probe's path exists in the tree, the probe is left out and the file is judged as a gate file instead. Probes are judged only when a CODEOWNERS file is in use and the config was read. They are judged even when the tree could not be read or was truncated, since they do not depend on it. The paths probed are listed in check 1's `details.probedPaths`.

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
  - **Any other case** is not verified: another error kind, a line where only some owners are flagged, or an error with no `column`. The path is `codeowners_error_ambiguous` if either reading could give it an owner: GitHub applies the line with the owners it did not flag (every owner, when an error has no `column`), or GitHub ignores the line and an earlier line owns the path. When both readings leave the path with no owner, it is unowned.
- **Team and email owners** are reported as written. Their members are not read.

## 1. `gate_files_owned`

- **Reads:** the tree at the default branch's head (`GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`, with that SHA recorded), the CODEOWNERS file in use, `codeowners/errors`, the rules, and classic protection.
- **`pass`:** every gate file and every probe path has at least one owner, and the default branch requires code-owner review.
- **`fail`:**
  - `gate_files_unowned`, listing the files;
  - `new_gate_paths_unowned`, listing the [probe paths](#probe-paths-files-that-would-change-the-gate-if-added) with no owner;
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

- **`pass`:** approval of the most recent push by someone else is required, and no agent identity is a code owner of any gate file or probe path.
- **`fail`:**
  - `agent_is_code_owner`, naming the identity and the files. A probe path in the list means the agent would own a new file there;
  - `last_push_approval_not_required`.
- **`unverifiable`:**
  - `no_agent_identities`;
  - the tree and CODEOWNERS reasons from check 1;
  - `unresolved_owners`: a gate file is owned by a team or an email address, and a declared user agent could be behind it (an app's bot account cannot be);
  - `agent_app_unresolved`: a declared agent app's slug did not resolve, and no id was declared;
  - `agent_app_id_mismatch`: the declared id and GitHub's id for the slug differ;
  - `agent_app_ids_conflict`: one slug is declared with different ids;
  - `agent_app_slugs_share_id`: two different declared slugs have the same id;
  - the reasons for an unreadable source.
- **Context:** GitHub never counts a pull request author's own approval toward required reviews. That is GitHub's behaviour, not this check.

## 4. `agents_cannot_bypass`

- **Reads:**
  - every ruleset in effect on the default branch, including organisation rulesets, with `GET /repos/{owner}/{repo}/rulesets/{id}?includes_parents=true`, taking the IDs from the effective rules;
  - the collaborators list;
  - classic protection;
  - `GET /orgs/{org}/memberships/{username}` for each user agent with admin permission, only when a ruleset that was read names an `OrganizationAdmin` bypass actor and an organisation owns the repository.
  - `GET /orgs/{org}/installations`, only when there is an agent app and an organisation owns the repository.
- **`fail`:**
  - `agent_app_can_bypass`: an `Integration` bypass actor. Every app that can bypass is treated as an agent app.
  - `agent_app_can_administer`: an agent app's installation has `administration: write` or `organization_administration: write`. See "App installation permissions" below.
  - `agent_role_can_bypass`: a role bypass covers an agent identity. For a `RepositoryRole` bypass, see the role names below. For an `OrganizationAdmin` bypass, the agent is a user whose organisation membership GitHub gives as role `admin` and state `active`: an organisation owner. See "Organisation admin bypass" below.
  - `agent_is_admin`: an agent identity has admin permission.
  - `admins_not_enforced_agent_is_admin`: classic protection has `enforce_admins` false and an agent identity is an admin.
  - `agent_in_bypass_allowance`: classic protection's `bypass_pull_request_allowances` names an agent identity.
- **`unverifiable`:**
  - `no_agent_identities`;
  - `rules_unreadable`;
  - `ruleset_unreadable`;
  - `bypass_list_unreadable`: a ruleset response has no `bypass_actors`. GitHub includes them only for tokens with write access to the ruleset;
  - `bypass_role_unknown`: a `RepositoryRole` bypass, while an agent identity holds a repository permission. GitHub does not document which `actor_id` is which built-in repository role: the REST reference says only that `actor_id` is required for `RepositoryRole`. So Darz cannot tell whether the role covers the agent, and the row cannot pass. Apps that are not collaborators hold no repository role, so they leave the row decidable (see "Apps and role bypasses" below). An agent with admin permission still fails as `agent_is_admin`. With `--graphql-ruleset-roles`, Darz reads the role's name from GitHub's GraphQL API and decides most of these instead; see below;
  - `bypass_role_inheritance_unknown`: with role names from GraphQL, a bypass role that is lower than an agent's role. GitHub does not document whether a role's bypass also covers the roles above it;
  - `bypass_role_order_unknown`: with role names from GraphQL, a bypass role that is not the agent's role, where one of the two is a custom role. Darz does not read where a custom role stands among the built-in roles;
  - `bypass_actor_unknown`;
  - `team_bypass_members_unread`: a team can bypass and a declared user agent could be a member;
  - `collaborators_unreadable`;
  - `classic_protection_unreadable`;
  - `field_missing`;
  - `agent_app_unresolved`, `agent_app_id_mismatch`, `agent_app_ids_conflict` or `agent_app_slugs_share_id`;
  - `config_invalid` or `config_unreadable`.
- **Context:** when the installations list cannot be read, a line says that installation permissions were not checked, and why. Deploy-key bypasses are listed.

### Organisation admin bypass

An `OrganizationAdmin` bypass actor covers the owners of the organisation that owns the repository. A repository admin who is not an owner is not covered. Darz reads each admin user agent's membership with `GET /orgs/{org}/memberships/{username}`:

| Membership | Result |
|---|---|
| role `admin`, state `active` | `fail`, `agent_role_can_bypass` |
| any other role, or state `pending` | not covered; a context line says so |
| not readable | coverage is not claimed; a context line says why |

- An agent with admin permission always fails as `agent_is_admin`, so the row fails in all three cases. An unknown membership is a context line, not a reason: an `unverifiable` reason is never listed beside a fail.
- GitHub answers 404 both for a user who is not a member of the organisation and for a membership the token cannot see. A 404 is never read as "not an owner". The token must belong to an organisation member to read another user's membership. The GitHub Actions workflow token cannot read it.
- GitHub's REST reference says `OrganizationAdmin` "is not applicable for personal repositories". On a repository owned by a user, the bypass covers no agent, nothing is read, and a context line says so.
- Only a person can be an organisation owner, so an app agent is never covered. See "Apps and role bypasses" below.

### Apps and role bypasses

Check 4 treats an agent app as holding no repository role and as never being an organisation owner. A `RepositoryRole` or `OrganizationAdmin` bypass is therefore never attributed to an app, unless the app's bot account appears in the collaborators list with a permission. This follows from GitHub's documentation:
- [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets): a bypass "can be users with a certain role, such as repository administrator, or it can be specific teams or GitHub Apps". Apps are their own kind of bypass actor, `Integration`, not role holders.
- [Repository roles for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization): roles go to "organization members, outside collaborators, and teams of people". GitHub Apps are not among them.
- [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app): "The success of an API request with an installation access token only depends on the app's permissions." An app acting as itself carries its installation's permissions, not a role.
- On a private test repository, read live on 2026-11-23, the installed App `barg-labs-agent` (`contents: write`, `pull_requests: write`) is not in `GET /repos/{owner}/{repo}/collaborators?affiliation=all`.

So an app acting with its installation token can match only an `Integration` bypass actor, which fails as `agent_app_can_bypass`. GitHub does not say in so many words that an app never matches a role bypass. This is read from the pages above and was not tested against a live ruleset, which would need a ruleset change.

An app acting with a user access token acts for that user: the request "depends on the user's permissions as well as the app's permissions". The user's role then applies, so declare that user with `--agent`. An app's installation permissions, such as `administration: write`, are a separate route; see "App installation permissions" below.

### App installation permissions

An app's installation permissions decide what it can change. With `administration: write` it can edit or delete the repository's rulesets and classic branch protection, and set collaborators' roles. With `organization_administration: write` it can edit or delete organisation rulesets. GitHub's [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) lists those endpoints under these two permissions. An agent app holding either can remove the rules that bind it, so the row fails with `agent_app_can_administer`.

- **Where Darz reads them:** `GET /repos/{owner}/{repo}/installation` needs the app's own JWT. [`GET /orgs/{org}/installations`](https://docs.github.com/en/rest/orgs/orgs#list-app-installations-for-an-organization) lists every installation on the organisation with its `app_id`, `app_slug`, `repository_selection` and `permissions`. GitHub serves it to an organisation owner's token, or a token with organisation Administration: read. Darz matches an installation to an agent app by `app_id`, or by `app_slug` when the app's id is not known.
- **Other permissions:** `repository_custom_properties: write` and `organization_custom_properties: write` or `admin` can change a repository's custom property values, which can take it out of an organisation ruleset that selects repositories by property. Whether they do depends on that ruleset's conditions, so these are a context line, not a fail. `workflows: write` and `contents: write` change files, which checks 1 to 3 cover; they do not change rulesets.
- **Selected repositories:** an installation on `selected` repositories is taken to cover this one. Darz does not read the selection. `GET /user/installations/{installation_id}/repositories` would give it, but only to a token that a GitHub App authorised or a personal access token. The GitHub CLI's OAuth token gets a 403 (seen live on 2026-11-23). An agent app acts on this repository, which it can do only if installed on it. The fail's subject gives `repository_selection`.
- **No installation:** an agent app with no installation on the organisation holds no installation permissions on its repositories. A context line says so.
- **When the list cannot be read:** a context line says the permissions were not checked, with the response. The row is decided without them. This is a context line, not an `unverifiable` reason, on purpose. The GitHub Actions workflow token can never read the list, so a reason would make check 4 `unverifiable` on every run with the default token. v0.1 never checked these permissions either.
- **Repositories owned by a user:** no token Darz takes can read a user's installations. `GET /users/{username}/installation` needs the app's JWT, and `GET /user/installations` needs a token that a GitHub App authorised. This is a permanent limit: a context line says the permissions were not checked.

### Role names from GraphQL (`--graphql-ruleset-roles`, off by default)

REST names a repository-role bypass actor only by its `actor_id`. GitHub's GraphQL schema also gives the role's name (`RepositoryRulesetBypassActor.repositoryRoleName`). With `--graphql-ruleset-roles`, or the Action input `graphql-ruleset-roles: true`, Darz reads it and compares it with each agent's collaborator `role_name`:

| Agent's role compared with the bypass role | Result |
|---|---|
| The same role, built-in or custom | `fail`, `agent_role_can_bypass` |
| A lower built-in role | not covered |
| A higher built-in role | `unverifiable`, `bypass_role_inheritance_unknown` |
| A custom role that does not match | `unverifiable`, `bypass_role_order_unknown` |

This is the one exception to Darz's GET-only rule. GraphQL queries are POST requests.
- The reader is separate from the GET-only client.
- It sends only query documents compiled into Darz, and it refuses anything that is not one of them. At load, it checks that none is a mutation or a subscription.
- It calls only the configured API host's GraphQL endpoint.
- It runs only when check 4 can use its answer: a ruleset that was read has a repository-role bypass actor, and an agent identity holds a repository permission in the collaborators list that was read. Otherwise nothing is sent.
- It reads every page of rulesets. A ruleset whose bypass actors run past one page is not used. A cursor that does not advance stops the read as an `error` of kind `unexpected_shape`.
- A GraphQL error that points into one ruleset costs only that ruleset; the others on the page are still used. An error that points at no single ruleset makes the whole read unusable. Errors are told apart by their `type`, never their message: `FORBIDDEN`, `NOT_FOUND` and `INSUFFICIENT_SCOPES` are `not_permitted`, `RATE_LIMITED` is an `error` of kind `rate_limited`, and anything else is an `error`.
- GitHub does not document that GraphQL's `repositoryRoleDatabaseId` is REST's `actor_id`. So a ruleset's role names are used only when its GraphQL role ids are exactly its REST `RepositoryRole` actor ids. Where they differ, the ruleset stays `bypass_role_unknown`.
- If the read fails, or a ruleset's names cannot be used, Darz falls back to `bypass_role_unknown`, and the row's context says why.

The record lists the GraphQL read as one entry, `POST <path>#<query name>`, with the path actually posted to: `/graphql`, or `/api/graphql` on GitHub Enterprise Server. The entry carries `pages`, the number of pages read, and `partial: true` when some rulesets had errors. Check 4's row lists the read too. `options.graphqlRulesetRoles` says whether the reader was asked for; whether it ran is the `POST` entry in `reads`.

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
- **`unverifiable`:** `rules_unreadable`, `classic_protection_unreadable` or `field_missing`. When a required check is pinned to an app, also `no_agent_identities`, `agent_app_unresolved`, `agent_app_id_mismatch`, `agent_app_ids_conflict`, `agent_app_slugs_share_id`, `config_invalid` or `config_unreadable`: the app could be an agent's that Darz cannot name. A source Darz could not read could pin a check or require another one, so with a source unreadable the row is never a pass. An unpinned check is not a fail while a source that could pin it is unreadable.
- **Context (`details`):** each required check with the app ids it is pinned to (empty for any source), and whether the branch must be up to date before merging (`true`, `false` or `"unknown"`).
- **Note:** a check pinned to GitHub Actions is produced by a workflow. Whether an agent can change that workflow is what check 1 answers.

## 6. `agent_merges_touching_gates`

This check is context: it never passes or fails.

- **Reads:**
  - closed pull requests into the default branch, newest update first (`GET /repos/{owner}/{repo}/pulls?state=closed&base={branch}&sort=updated&direction=desc&per_page=100`), page by page, and keeps the N most recently merged (`--merges`, default 50). The row's `read` lists every page read. See "Which merges are read" below;
  - for each pull request by an agent identity: its file list and its reviews, every page of each;
  - for each candidate file (`package.json`, `vite.config.*`, `pyproject.toml`, `setup.cfg`) that an agent pull request changed, and that no gate pattern already covers: the file as it was at the merge. See "Candidate files at the merge" below.
- **Details:**
  - for each agent pull request: its number, link, author, merge time, the gate files it changed, the candidate files it changed whose contents at the merge are unknown (`candidatesUnknown`), and its approvers. An approver is a reviewer whose latest review that sets a state is `APPROVED`; `COMMENTED` and `PENDING` reviews do not set a state;
  - counts of agent merges, and of agent merges that touched gate files.

  It gives counts and links only, with no judgement of intent. If fewer than N merged pull requests exist, the row says how many were read.

  **Which merges are read.** The list is sorted by update time, not merge time, and GitHub has no sort by merge time. A pull request merged long ago and updated since (for example by a comment) comes early in the list. Merging sets `updated_at`, so a pull request's merge time is never later than its update time. Darz therefore reads until the oldest `updated_at` read is older than the Nth newest `merged_at` read: every pull request after that point merged earlier than the Nth, so none of them can be among the last N. It also stops at the end of the list.

  Darz reads at most N / 100 pages, rounded up, plus 10 (`MERGE_EXTRA_PAGES`): 11 pages for the default 50, so at most 1,100 closed pull requests. If it reaches that cap with pages left and the condition above does not hold yet, a later merge may be missing. The row is then `unverifiable` with `merges_incomplete`, whose subject gives the pages read, and the details describe the merges that were read. This is a reason, not a context line, for the same reason as a file list at GitHub's cap: the row could leave out an agent merge that touched gate files, and a check that may leave something out is never reported as complete.

  **Candidate files at the merge.** A candidate file is a gate file only while it holds test or coverage settings, and that can change. A file that held them when an agent changed it, and no longer does, was still a gate change; the reverse was not. So check 6 judges each changed candidate by its contents at that pull request's merge, not at the head:
  - a file the pull request added or modified: `GET /repos/{owner}/{repo}/contents/{path}?ref={merge_commit_sha}`. `merge_commit_sha` comes from the pull request list. For a merge or squash merge it is the commit on the default branch that the merge made; for a rebase merge it is the last rebased commit;
  - a file the pull request removed: the blob it removed, `GET /repos/{owner}/{repo}/git/blobs/{sha}`, where `sha` is the file list's `sha` for the removed file. That is the file as it was before the deletion. GitHub does not document what `sha` is for a removed file; on a live pull request (nodejs/node#67620, `deps/simdjson/LICENSE`, 23 Nov 2026) it was the blob at the pull request's base. A removed file with no `sha` is read like a rename's old name;
  - a rename's old name: the file at the merge commit's first parent, which is the default branch just before the merge for a merge or squash merge. That takes `GET /repos/{owner}/{repo}/git/commits/{merge_commit_sha}` for the parent, once per pull request, then the contents read at the parent.

  A candidate that an exact gate path or a gate pattern (yours included) already covers is a gate file without a read. The judgement is the same as for check 1 (see Gate files).

  **Bound on reads.** Darz makes at most 100 of these reads in one run (`MAX_MERGE_CANDIDATE_READS`), counting each file read and each merge commit read. It takes the agent pull requests newest merge first. The first pull request whose reads would pass the cap, and every older one, is not read: the row is `unverifiable` with `gate_candidates_at_merge_over_cap`, naming them. Most agent pull requests change no candidate file and cost nothing.

  If a read fails, the file is missing where it should be, the file cannot be parsed, or the merge has no `merge_commit_sha`, the row is `unverifiable` with `gate_candidate_at_merge_unreadable`, naming the pull request, the file and why. In both cases the file is listed in that pull request's `candidatesUnknown`, and its `gateFilesChanged` is a lower bound. Every read is listed in the row's `read`.

  GitHub's file list for a pull request stops at 3,000 files without saying so. A list that reaches 3,000 is treated as possibly cut off: the pull request is marked `fileListTruncated: true`, its gate files are a lower bound, and the row is `unverifiable`.
- **`unverifiable`:**
  - `no_agent_identities`;
  - `merges_unreadable`;
  - `merges_incomplete`;
  - `pull_request_files_unreadable`;
  - `pull_request_files_truncated`;
  - `gate_candidate_at_merge_unreadable`;
  - `gate_candidates_at_merge_over_cap`;
  - `pull_request_reviews_unreadable`;
  - `agent_app_unresolved`, `agent_app_id_mismatch`, `agent_app_ids_conflict` or `agent_app_slugs_share_id`;
  - `config_invalid` or `config_unreadable`.

## All reasons

| Reason | Status | Checks | Meaning |
|---|---|---|---|
| `repository_unreadable` | unverifiable | all | The repository itself could not be read (exit code 3). |
| `no_agent_identities` | unverifiable | 3, 4, 5, 6 | No agent identity was declared or detected (check 5: only when a required check is pinned to an app). |
| `config_invalid` | unverifiable | 1, 3, 4, 5, 6 | `.github/darz.json` exists but is not valid. |
| `config_unreadable` | unverifiable | 1, 3, 4, 5, 6 | `.github/darz.json` could not be read. |
| `field_missing` | unverifiable | 1-5 | A field the check needs is missing from a response that was read; the subjects name it. |
| `rules_unreadable` | unverifiable | 1-5 | The effective rules could not be read. |
| `classic_protection_unreadable` | unverifiable | 1-5 | The branch is protected and classic protection could not be read. |
| `tree_unreadable` | unverifiable | 1, 3 | The tree could not be read. |
| `tree_truncated` | unverifiable | 1, 3 | GitHub truncated the tree. |
| `codeowners_unreadable` | unverifiable | 1, 3 | A CODEOWNERS file could not be read. |
| `codeowners_errors_unreadable` | unverifiable | 1, 3 | `codeowners/errors` could not be read. |
| `codeowners_error_ambiguous` | unverifiable | 1, 3 | A reported CODEOWNERS line, of a kind whose handling is not verified, is the last match, and either its unflagged owners or an earlier line could own the path. |
| `gate_files_unowned` | fail | 1 | Gate files with no code owner. |
| `new_gate_paths_unowned` | fail | 1 | Probe paths with no code owner: a CODEOWNERS location GitHub reads before the file in use, or a new file in a gate directory. |
| `no_codeowners_file` | fail | 1 | No CODEOWNERS file and no gate files. |
| `code_owner_review_not_required` | fail | 1 | Code-owner review is not required. |
| `no_pull_request_rule` | fail | 2 | No source requires a pull request. |
| `approving_review_not_required` | fail | 2 | No approving review is required. |
| `stale_reviews_not_dismissed` | fail | 2 | Stale approvals are kept on push. |
| `last_push_approval_not_required` | fail | 2, 3 | Approval of the last push by someone else is not required. |
| `agent_is_code_owner` | fail | 3 | An agent identity owns gate files. |
| `unresolved_owners` | unverifiable | 3 | Team or email owners of gate files, with a declared user agent. |
| `agent_app_unresolved` | unverifiable | 3, 4, 5, 6 | A declared agent app's slug did not resolve with `GET /apps/{slug}`, and no id was declared. |
| `agent_app_id_mismatch` | unverifiable | 3, 4, 5, 6 | A declared agent app's id differs from GitHub's id for its slug. |
| `agent_app_ids_conflict` | unverifiable | 3, 4, 5, 6 | One agent app slug is declared with different ids. |
| `agent_app_slugs_share_id` | unverifiable | 3, 4, 5, 6 | Two different declared agent app slugs have the same app id. |
| `agent_app_can_bypass` | fail | 4 | An app is a ruleset bypass actor. |
| `agent_app_can_administer` | fail | 4 | An agent app's installation has `administration: write` or `organization_administration: write`. |
| `agent_role_can_bypass` | fail | 4 | A role bypass covers an agent identity: the agent holds the bypass role, or is an organisation owner under an `OrganizationAdmin` bypass. |
| `agent_is_admin` | fail | 4 | An agent identity is an admin. |
| `admins_not_enforced_agent_is_admin` | fail | 4 | `enforce_admins` is off and an agent identity is an admin. |
| `agent_in_bypass_allowance` | fail | 4 | Classic protection lets an agent identity bypass pull request requirements. |
| `ruleset_unreadable` | unverifiable | 4 | A ruleset in effect could not be read. |
| `bypass_list_unreadable` | unverifiable | 4 | A ruleset response has no `bypass_actors`. |
| `bypass_role_unknown` | unverifiable | 4 | A repository-role bypass, while an agent holds a repository permission; GitHub does not document role ids, and role names from GraphQL were not asked for or could not be used. |
| `bypass_role_inheritance_unknown` | unverifiable | 4 | With role names from GraphQL, a bypass role lower than an agent's role. |
| `bypass_role_order_unknown` | unverifiable | 4 | With role names from GraphQL, a bypass role that does not match an agent's role, where one of them is a custom role. |
| `bypass_actor_unknown` | unverifiable | 4 | A bypass names an unknown actor type. |
| `team_bypass_members_unread` | unverifiable | 4 | A team can bypass and a declared user agent could be a member. |
| `collaborators_unreadable` | unverifiable | 4 | The collaborators list could not be read. |
| `no_required_checks` | fail | 5 | No status check is required. |
| `required_check_unpinned` | fail | 5 | A required check is not pinned to the app that must report it. |
| `required_check_pinned_to_agent_app` | fail | 5 | A required check is pinned to an agent app. |
| `gate_candidate_unreadable` | unverifiable | 1, 3 | A candidate file could not be read or parsed. |
| `gate_candidates_over_cap` | unverifiable | 1, 3 | More than 500 distinct candidate files outside `node_modules`. |
| `merges_unreadable` | unverifiable | 6 | Merged pull requests could not be read. |
| `merges_incomplete` | unverifiable | 6 | The pull request list reached Darz's page cap before a later merge could be ruled out. |
| `pull_request_files_unreadable` | unverifiable | 6 | An agent pull request's file list could not be read. |
| `pull_request_files_truncated` | unverifiable | 6 | An agent pull request's file list reached GitHub's 3,000-file limit. |
| `pull_request_reviews_unreadable` | unverifiable | 6 | An agent pull request's reviews could not be read. |
| `gate_candidate_at_merge_unreadable` | unverifiable | 6 | A candidate file an agent pull request changed could not be read or parsed as it was at the merge. |
| `gate_candidates_at_merge_over_cap` | unverifiable | 6 | Reading changed candidate files at their merges would pass 100 reads; these pull requests were not read. |
