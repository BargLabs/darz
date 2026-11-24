// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs

import { Buffer } from "node:buffer";
import { globMatches } from "../gates.js";
import {
  LESSONS_DIR,
  type Lesson,
  MAX_FILE_BYTES,
  MAX_LESSONS,
  MAX_LESSON_FILE_READS,
  parseLesson,
} from "../lessons.js";
import type { GitHubClient, ReadResult } from "./client.js";
import type { Snapshot } from "./snapshot.js";
import type { ContentEntry, PullData, ReviewData, TreeData } from "./types.js";

const HEX_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * How the latest change to one lesson file was approved, as read: the newest
 * commit on the default branch that touched the file, the pull requests
 * GitHub associates with that commit, and the reviews of the one chosen.
 */
export interface ApprovalRead {
  commits: ReadResult<Array<{ sha?: string }>>;
  /** The latest commit that touched the file, when the read gave one. */
  commit: string | null;
  pulls: ReadResult<PullData[]> | null;
  reviews: ReadResult<ReviewData[]> | null;
  /** The merged pull request into the default branch that brought the commit, when exactly one could be chosen. */
  pull: PullData | null;
  /** How the pull request was chosen: none merged into the default branch, one, or several with none singled out. */
  choice: "none" | "one" | "several" | null;
}

export interface LessonFileRead {
  path: string;
  name: string;
  /** The entry's type in the directory listing: file, dir, symlink or submodule. */
  type: string;
  blobEndpoint: string | null;
  /** The file's text, or null when it was not read or is not a file. */
  text: string | null;
  parsed: { lesson: Lesson } | { problem: string } | null;
  approval: ApprovalRead | null;
}

/** A file a lesson checks, at the commit read. */
export type TargetFile =
  | { state: "read"; text: string; endpoint: string }
  | { state: "too_large"; why: string; endpoint: string | null }
  | { state: "unreadable"; endpoint: string };

export type TargetsRead =
  | { state: "tree_unreadable"; endpoint: string }
  | { state: "tree_truncated"; endpoint: string }
  | { state: "over_cap"; endpoint: string; files: number }
  | { state: "read"; endpoint: string; paths: string[]; files: Map<string, TargetFile> };

export type LessonsRead =
  | { state: "not_read" }
  | { state: "unreadable"; endpoint: string }
  | { state: "too_many"; endpoint: string; count: number }
  | { state: "read"; endpoint: string; head: string; ref: string; files: LessonFileRead[]; targets: TargetsRead };

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function decodeBlob(r: ReadResult<{ encoding?: string; content?: string }>): string | null {
  return r.state === "read" && r.data?.encoding === "base64" && typeof r.data.content === "string"
    ? Buffer.from(r.data.content, "base64").toString("utf8")
    : null;
}

/** An active lesson: valid and not retired. Only these have files to read. */
function active(f: LessonFileRead): Lesson | null {
  return f.parsed && "lesson" in f.parsed && f.parsed.lesson.retired === undefined ? f.parsed.lesson : null;
}

/**
 * Read everything check 7 needs. Lesson files always come from the default
 * branch's head; `ref` is the commit whose files the lessons are run over.
 * Judging approvals needs the agent identities, so it is left to the check.
 */
export async function readLessons(client: GitHubClient, snap: Snapshot, ref: string | null): Promise<LessonsRead> {
  const head = snap.commitSha;
  const branch = snap.defaultBranch;
  if (!snap.repositoryReadable || head === null || branch === null) return { state: "not_read" };
  const R = `/repos/${encodeURIComponent(snap.owner)}/${encodeURIComponent(snap.name)}`;
  const at = ref ?? head;

  const dirPath = `${R}/contents/${encodePath(LESSONS_DIR)}?ref=${head}`;
  const dir = await client.get<ContentEntry[]>(dirPath, "file");
  if (dir.state !== "read") return { state: "unreadable", endpoint: dirPath };
  const entries = dir.absent ? [] : dir.data;
  if (!Array.isArray(entries)) return { state: "unreadable", endpoint: dirPath };
  if (entries.length > MAX_LESSONS) return { state: "too_many", endpoint: dirPath, count: entries.length };

  const pullsByCommit = new Map<string, Promise<ReadResult<PullData[]>>>();
  const reviewsByPull = new Map<number, Promise<ReadResult<ReviewData[]>>>();
  const readApproval = async (path: string): Promise<ApprovalRead> => {
    // The newest commit on the default branch that touched the file is the
    // first item of this newest-first list; one item of one page is enough.
    const commits = await client.get<Array<{ sha?: string }>>(
      `${R}/commits?sha=${head}&path=${encodeURIComponent(path)}&per_page=1`,
      "content",
    );
    const out: ApprovalRead = { commits, commit: null, pulls: null, reviews: null, pull: null, choice: null };
    const sha = commits.state === "read" && Array.isArray(commits.data) ? commits.data[0]?.sha : undefined;
    if (typeof sha !== "string" || !HEX_SHA.test(sha)) return out;
    out.commit = sha;
    let pulls = pullsByCommit.get(sha);
    if (!pulls) {
      pulls = client.getAll<PullData>(`${R}/commits/${sha}/pulls?per_page=100`, "content");
      pullsByCommit.set(sha, pulls);
    }
    out.pulls = await pulls;
    if (out.pulls.state !== "read") return out;
    const merged = (out.pulls.data ?? []).filter(
      (p) => typeof p.merged_at === "string" && p.merged_at.length > 0 && p.base?.ref === branch,
    );
    const exact = merged.filter((p) => p.merge_commit_sha === sha);
    const chosen = merged.length === 1 ? merged[0] : exact.length === 1 ? exact[0] : undefined;
    out.choice = merged.length === 0 ? "none" : chosen ? "one" : "several";
    if (!chosen || typeof chosen.number !== "number") return out;
    out.pull = chosen;
    let reviews = reviewsByPull.get(chosen.number);
    if (!reviews) {
      reviews = client.getAll<ReviewData>(`${R}/pulls/${chosen.number}/reviews?per_page=100`, "content");
      reviewsByPull.set(chosen.number, reviews);
    }
    out.reviews = await reviews;
    return out;
  };

  const files = await Promise.all(
    entries.map(async (e): Promise<LessonFileRead> => {
      const path = typeof e.path === "string" ? e.path : `${LESSONS_DIR}/${String(e.name)}`;
      const name = typeof e.name === "string" ? e.name : path.slice(path.lastIndexOf("/") + 1);
      const type = typeof e.type === "string" ? e.type : "unknown";
      const base: LessonFileRead = { path, name, type, blobEndpoint: null, text: null, parsed: null, approval: null };
      if (type !== "file") return base;
      const [text, approval] = await Promise.all([
        (async () => {
          if (typeof e.sha !== "string" || !HEX_SHA.test(e.sha)) return null;
          base.blobEndpoint = `${R}/git/blobs/${e.sha}`;
          return decodeBlob(await client.get(base.blobEndpoint, "content"));
        })(),
        readApproval(path),
      ]);
      base.text = text;
      base.approval = approval;
      if (text !== null) base.parsed = parseLesson(text, name);
      return base;
    }),
  );
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const targets = await readTargets(client, R, snap, at, files.map(active).filter((l): l is Lesson => l !== null));
  return { state: "read", endpoint: dirPath, head, ref: at, files, targets };
}

async function readTargets(
  client: GitHubClient,
  R: string,
  snap: Snapshot,
  ref: string,
  lessons: Lesson[],
): Promise<TargetsRead> {
  const treePath = `${R}/git/trees/${ref}?recursive=1`;
  // With no lesson in force there is nothing to run, so nothing is read.
  if (lessons.length === 0) return { state: "read", endpoint: treePath, paths: [], files: new Map() };
  // At the default branch's head the tree is already read.
  const tree: ReadResult<TreeData> =
    ref === snap.commitSha && snap.tree ? snap.tree : await client.get<TreeData>(treePath, "content");
  if (tree.state !== "read" || !Array.isArray(tree.data?.tree) || typeof tree.data?.truncated !== "boolean") {
    return { state: "tree_unreadable", endpoint: treePath };
  }
  if (tree.data.truncated) return { state: "tree_truncated", endpoint: treePath };
  const blobs = tree.data.tree.filter(
    (e) => e.type === "blob" && typeof e.path === "string" && typeof e.sha === "string",
  ) as Array<{ path: string; sha: string; size?: number }>;
  const paths = blobs.map((b) => b.path).sort();

  const wanted = blobs.filter((b) => lessons.some((l) => l.check.paths.some((g) => globMatches(g, b.path))));
  const files = new Map<string, TargetFile>();
  const toRead = new Map<string, string[]>();
  for (const b of wanted) {
    if (typeof b.size === "number" && b.size > MAX_FILE_BYTES) {
      files.set(b.path, { state: "too_large", why: `${b.size} bytes`, endpoint: null });
      continue;
    }
    toRead.set(b.sha, [...(toRead.get(b.sha) ?? []), b.path]);
  }
  if (toRead.size > MAX_LESSON_FILE_READS) return { state: "over_cap", endpoint: treePath, files: toRead.size };
  // Files with the same blob have the same text, so each blob is read once.
  await Promise.all(
    [...toRead.entries()].map(async ([sha, at]) => {
      const endpoint = `${R}/git/blobs/${sha}`;
      const text = decodeBlob(await client.get(endpoint, "content"));
      for (const path of at) {
        if (text === null) files.set(path, { state: "unreadable", endpoint });
        else if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
          files.set(path, { state: "too_large", why: `${Buffer.byteLength(text)} bytes`, endpoint });
        } else files.set(path, { state: "read", text, endpoint });
      }
    }),
  );
  return { state: "read", endpoint: treePath, paths, files };
}
