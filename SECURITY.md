# Security

Darz reads a repository's settings with GET requests only. It never writes to any API, never prints, logs or stores the token, and calls no host other than the configured API URL. A report that any of these can be broken is a security issue.

There is one opt-in exception to GET only. `--graphql-ruleset-roles` sends GraphQL queries, which travel as POST requests. They are compiled into Darz and are never a mutation. A way to make that reader send anything else is also a security issue.

So is a way to make Darz report `pass` for a setting it could not read or that does not hold. Darz is meant to fail closed: an unreadable setting is `unverifiable`, never `pass`.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: the **Security** tab, then **Report a vulnerability**. Please do not open a public issue for a security problem.

Include:
- the Darz version or commit;
- the command or workflow you ran;
- what you expected;
- what happened.

Remove any token from logs before you send them.

## Supported versions

Only the latest release receives fixes.
