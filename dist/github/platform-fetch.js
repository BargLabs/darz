// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
/**
 * The platform fetch, as the CLI and the Action use it. Method, headers and
 * body pass through unchanged. It never follows a redirect itself: the client
 * sees the 3xx and its Location, and follows only a Location under the API URL
 * (GitHubClient, MAX_REDIRECTS), so no host other than the API URL is called.
 */
export const platformFetch = (url, init) => fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: "manual",
});
