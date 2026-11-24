// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

// Hand-written fixtures for check 7: the lessons directory on the default
// branch, each lesson file's latest commit, that commit's pull request and its
// reviews, shaped like GitHub's REST responses. No network.

import { createHash } from "node:crypto";
import type { FakeResponse, Routes } from "../helpers/fake-fetch.js";
import { paged } from "../helpers/fake-fetch.js";
import { type Fixture, REPO, SHA, b64, blobSha, ok } from "./github.js";

const R = `/repos/${REPO}`;
export const LESSONS = ".github/darz/lessons";

/** The pull request's final head commit, unless a test gives another. */
export const PR_HEAD = "3333333333333333333333333333333333333333";
export const EARLIER_HEAD = "4444444444444444444444444444444444444444";
/** A commit other than the default branch's head, for --ref. */
export const REF = "2222222222222222222222222222222222222222";

export const HUMAN_AUTHOR = "bob";
export const HUMAN_REVIEWER = "alice";

export function commitFor(file: string): string {
  return createHash("sha1").update(`lesson-commit:${file}`).digest("hex");
}

export function lessonJson(id: string, check: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      id,
      statement: `Lesson ${id}.`,
      evidence: [{ kind: "commit", ref: "852138aa046cfddadca6b256f6c877f4ee51ac83" }],
      check,
      ...extra,
    },
    null,
    2,
  );
}

export function pull(number: number, o: { author?: string; head?: string; merged?: boolean; base?: string; mergeCommit?: string } = {}) {
  return {
    number,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    user: { login: o.author ?? HUMAN_AUTHOR, type: "User" },
    merged_at: o.merged === false ? null : "2026-11-20T10:00:00Z",
    base: { ref: o.base ?? "main" },
    head: { sha: o.head ?? PR_HEAD },
    merge_commit_sha: o.mergeCommit ?? null,
  };
}

let reviewId = 0;
export function review(login: string, state: string, commitId = PR_HEAD, type = "User") {
  reviewId += 1;
  return { id: reviewId, user: { login, type }, state, commit_id: commitId, submitted_at: "2026-11-20T09:00:00Z" };
}

export interface LessonFixture {
  /** The file's name in the lessons directory. */
  name: string;
  text: string;
  /** GET .../commits?sha=<head>&path=<file>&per_page=1; default: one commit, commitFor(file). */
  commits?: FakeResponse;
  /** GET .../commits/<commit>/pulls; default: one merged pull request, number 40 + index. */
  pulls?: FakeResponse | unknown[][];
  /** GET .../pulls/<n>/reviews; default: alice approves the final head. */
  reviews?: FakeResponse | unknown[][];
  /** The pull request number the default pulls use. */
  number?: number;
}

export interface LessonsOptions {
  /** The lessons directory listing; default: one entry per lesson. */
  dir?: FakeResponse;
  /** Files at the default branch's head that lessons check, by path. */
  files?: Record<string, string>;
}

function list(path: string, value: FakeResponse | unknown[][]): Routes {
  return Array.isArray(value) ? paged(path, value) : { [path]: value };
}

/** Add lessons, their approvals and the files they check to a fixture. */
export function withLessons(fx: Fixture, lessons: LessonFixture[], o: LessonsOptions = {}): Fixture {
  const paths = lessons.map((l) => `${LESSONS}/${l.name}`);
  const treeBody = (fx.tree.body as { tree: Array<{ path: string }> } | undefined)?.tree ?? [];
  const extraPaths = [...paths, ...Object.keys(o.files ?? {})].filter((p) => !treeBody.some((e) => e.path === p));
  if (fx.tree.body && typeof fx.tree.body === "object") {
    (fx.tree.body as { tree: unknown[] }).tree.push(
      ...extraPaths.map((path) => ({ path, mode: "100644", type: "blob", sha: blobSha(path), size: 10 })),
    );
  }
  for (const [path, text] of Object.entries(o.files ?? {})) fx.blobs[path] = text;
  fx.extra[`${R}/contents/${LESSONS}?ref=${SHA}`] =
    o.dir ??
    ok(lessons.map((l, i) => ({ type: "file", name: l.name, path: paths[i], sha: blobSha(paths[i] as string), size: l.text.length })));
  lessons.forEach((l, i) => {
    const path = paths[i] as string;
    const n = l.number ?? 40 + i;
    const commit = commitFor(path);
    fx.blobs[path] = l.text;
    fx.extra[`${R}/commits?sha=${SHA}&path=${encodeURIComponent(path)}&per_page=1`] = l.commits ?? ok([{ sha: commit }]);
    Object.assign(fx.extra, list(`${R}/commits/${commit}/pulls?per_page=100`, l.pulls ?? [[pull(n)]]));
    Object.assign(
      fx.extra,
      list(`${R}/pulls/${n}/reviews?per_page=100`, l.reviews ?? [[review(HUMAN_REVIEWER, "APPROVED")]]),
    );
  });
  return fx;
}

/** A blob SHA for a path as it is at another commit, so its content can differ from the head's. */
export function blobAt(commit: string, path: string): string {
  return createHash("sha1").update(`blob:${commit}:${path}`).digest("hex");
}

/**
 * A tree at a commit other than the head, with each file's text: the tree
 * route and one blob route per file, each blob distinct from the head's.
 */
export function treeAtRoutes(commit: string, files: Record<string, string>, truncated = false): Routes {
  const routes: Routes = {
    [`${R}/git/trees/${commit}?recursive=1`]: ok({
      sha: commit,
      tree: Object.entries(files).map(([path, text]) => ({
        path,
        mode: "100644",
        type: "blob",
        sha: blobAt(commit, path),
        size: Buffer.byteLength(text),
      })),
      truncated,
    }),
  };
  for (const [path, text] of Object.entries(files)) {
    routes[`${R}/git/blobs/${blobAt(commit, path)}`] = ok({
      sha: blobAt(commit, path),
      encoding: "base64",
      content: b64(text),
      size: Buffer.byteLength(text),
    });
  }
  return routes;
}
