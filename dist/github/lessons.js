// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { Buffer } from "node:buffer";
import { globMatches } from "../gates.js";
import { LESSONS_DIR, MAX_FILE_BYTES, MAX_LESSONS, MAX_LESSON_FILE_READS, parseLesson, } from "../lessons.js";
const HEX_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}
function decodeBlob(r) {
    return r.state === "read" && r.data?.encoding === "base64" && typeof r.data.content === "string"
        ? Buffer.from(r.data.content, "base64").toString("utf8")
        : null;
}
/** An active lesson: valid and not retired. Only these have files to read. */
function active(f) {
    return f.parsed && "lesson" in f.parsed && f.parsed.lesson.retired === undefined ? f.parsed.lesson : null;
}
/**
 * Read everything check 7 needs. Lesson files always come from the default
 * branch's head; `ref` is the commit whose files the lessons are run over.
 * Judging approvals needs the agent identities, so it is left to the check.
 */
export async function readLessons(client, snap, ref) {
    const head = snap.commitSha;
    const branch = snap.defaultBranch;
    if (!snap.repositoryReadable || head === null || branch === null)
        return { state: "not_read" };
    const R = `/repos/${encodeURIComponent(snap.owner)}/${encodeURIComponent(snap.name)}`;
    const at = ref ?? head;
    const dirPath = `${R}/contents/${encodePath(LESSONS_DIR)}?ref=${head}`;
    const dir = await client.get(dirPath, "file");
    if (dir.state !== "read")
        return { state: "unreadable", endpoint: dirPath };
    const entries = dir.absent ? [] : dir.data;
    if (!Array.isArray(entries))
        return { state: "unreadable", endpoint: dirPath };
    if (entries.length > MAX_LESSONS)
        return { state: "too_many", endpoint: dirPath, count: entries.length };
    const pullsByCommit = new Map();
    const reviewsByPull = new Map();
    const readApproval = async (path) => {
        // The newest commit on the default branch that touched the file is the
        // first item of this newest-first list; one item of one page is enough.
        const commits = await client.get(`${R}/commits?sha=${head}&path=${encodeURIComponent(path)}&per_page=1`, "content");
        const out = { commits, commit: null, pulls: null, reviews: null, pull: null, choice: null };
        const sha = commits.state === "read" && Array.isArray(commits.data) ? commits.data[0]?.sha : undefined;
        if (typeof sha !== "string" || !HEX_SHA.test(sha))
            return out;
        out.commit = sha;
        let pulls = pullsByCommit.get(sha);
        if (!pulls) {
            pulls = client.getAll(`${R}/commits/${sha}/pulls?per_page=100`, "content");
            pullsByCommit.set(sha, pulls);
        }
        out.pulls = await pulls;
        if (out.pulls.state !== "read")
            return out;
        const merged = (out.pulls.data ?? []).filter((p) => typeof p.merged_at === "string" && p.merged_at.length > 0 && p.base?.ref === branch);
        const exact = merged.filter((p) => p.merge_commit_sha === sha);
        const chosen = merged.length === 1 ? merged[0] : exact.length === 1 ? exact[0] : undefined;
        out.choice = merged.length === 0 ? "none" : chosen ? "one" : "several";
        if (!chosen || typeof chosen.number !== "number")
            return out;
        out.pull = chosen;
        let reviews = reviewsByPull.get(chosen.number);
        if (!reviews) {
            reviews = client.getAll(`${R}/pulls/${chosen.number}/reviews?per_page=100`, "content");
            reviewsByPull.set(chosen.number, reviews);
        }
        out.reviews = await reviews;
        return out;
    };
    const files = await Promise.all(entries.map(async (e) => {
        const path = typeof e.path === "string" ? e.path : `${LESSONS_DIR}/${String(e.name)}`;
        const name = typeof e.name === "string" ? e.name : path.slice(path.lastIndexOf("/") + 1);
        const type = typeof e.type === "string" ? e.type : "unknown";
        const base = { path, name, type, blobEndpoint: null, text: null, parsed: null, approval: null };
        if (type !== "file")
            return base;
        const [text, approval] = await Promise.all([
            (async () => {
                if (typeof e.sha !== "string" || !HEX_SHA.test(e.sha))
                    return null;
                base.blobEndpoint = `${R}/git/blobs/${e.sha}`;
                return decodeBlob(await client.get(base.blobEndpoint, "content"));
            })(),
            readApproval(path),
        ]);
        base.text = text;
        base.approval = approval;
        if (text !== null)
            base.parsed = parseLesson(text, name);
        return base;
    }));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const targets = await readTargets(client, R, snap, at, files.map(active).filter((l) => l !== null));
    return { state: "read", endpoint: dirPath, head, ref: at, files, targets };
}
async function readTargets(client, R, snap, ref, lessons) {
    const treePath = `${R}/git/trees/${ref}?recursive=1`;
    // With no lesson in force there is nothing to run, so nothing is read.
    if (lessons.length === 0)
        return { state: "read", endpoint: treePath, paths: [], files: new Map() };
    // At the default branch's head the tree is already read.
    const tree = ref === snap.commitSha && snap.tree ? snap.tree : await client.get(treePath, "content");
    if (tree.state !== "read" || !Array.isArray(tree.data?.tree) || typeof tree.data?.truncated !== "boolean") {
        return { state: "tree_unreadable", endpoint: treePath };
    }
    if (tree.data.truncated)
        return { state: "tree_truncated", endpoint: treePath };
    const blobs = tree.data.tree.filter((e) => e.type === "blob" && typeof e.path === "string" && typeof e.sha === "string");
    const paths = blobs.map((b) => b.path).sort();
    const wanted = blobs.filter((b) => lessons.some((l) => l.check.paths.some((g) => globMatches(g, b.path))));
    const files = new Map();
    const toRead = new Map();
    for (const b of wanted) {
        if (typeof b.size === "number" && b.size > MAX_FILE_BYTES) {
            files.set(b.path, { state: "too_large", why: `${b.size} bytes`, endpoint: null });
            continue;
        }
        toRead.set(b.sha, [...(toRead.get(b.sha) ?? []), b.path]);
    }
    if (toRead.size > MAX_LESSON_FILE_READS)
        return { state: "over_cap", endpoint: treePath, files: toRead.size };
    // Files with the same blob have the same text, so each blob is read once.
    await Promise.all([...toRead.entries()].map(async ([sha, at]) => {
        const endpoint = `${R}/git/blobs/${sha}`;
        const text = decodeBlob(await client.get(endpoint, "content"));
        for (const path of at) {
            if (text === null)
                files.set(path, { state: "unreadable", endpoint });
            else if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
                files.set(path, { state: "too_large", why: `${Buffer.byteLength(text)} bytes`, endpoint });
            }
            else
                files.set(path, { state: "read", text, endpoint });
        }
    }));
    return { state: "read", endpoint: treePath, paths, files };
}
