// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
// Read enough of a GitHub Actions workflow to answer one question for a context
// signal under check 1: is this workflow triggered by a pull request, and does
// it grant `checks: write` anywhere? Such a workflow, if it runs code a pull
// request controls, can post a check run as GitHub Actions without the pull
// request changing a workflow file. That is the path check 5's GitHub Actions
// note names but does not read.
//
// There is no YAML parser in this package, and runtime dependencies are not
// allowed, so this reads the shapes `on:` and `permissions:` take, by
// indentation: scalars, block maps and lists, and flow maps and lists on one
// line, with quoted or plain keys. Any other shape (a block scalar, an alias, a
// merge key, a tag, a flow value spread over lines, a value GitHub does not
// accept) reads as unknown, never as "no": the signal leans toward flagging,
// the safe side for a signal whose job is to prompt a human to look.
/** At most this many distinct workflow blobs are read in one run. */
export const MAX_WORKFLOW_READS = 500;
const PR_TRIGGERS = new Set(["pull_request", "pull_request_target"]);
/** The indentation (count of leading spaces) of a line, or -1 for a blank or comment-only line. */
function indentOf(line) {
    if (/^\s*(#.*)?$/.test(line))
        return -1;
    const m = /^( *)/.exec(line);
    return (m?.[1] ?? "").length;
}
/** Strip a trailing ` # comment`. Conservative: only when the `#` follows whitespace and is outside quotes. */
function stripComment(line) {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'" && !inDouble)
            inSingle = !inSingle;
        else if (c === '"' && !inSingle)
            inDouble = !inDouble;
        else if (c === "#" && !inSingle && !inDouble && i > 0 && /\s/.test(line[i - 1]))
            return line.slice(0, i);
    }
    return line;
}
function unquote(s) {
    const t = s.trim();
    return /^"[^"]*"$|^'[^']*'$/.test(t) ? t.slice(1, -1) : t;
}
/** The lines of one block: every line after `startIndex` more indented than `parentIndent`. */
function blockLines(lines, startIndex, parentIndent) {
    const out = [];
    for (let i = startIndex; i < lines.length; i++) {
        const ind = indentOf(lines[i]);
        if (ind === -1)
            continue;
        if (ind <= parentIndent)
            break;
        out.push(lines[i]);
    }
    return out;
}
/** The shallowest indent in a block, or null for an empty block. */
function baseIndent(block) {
    const ids = block.map(indentOf).filter((i) => i >= 0);
    return ids.length === 0 ? null : Math.min(...ids);
}
/** A `key: value` line, with a plain, double-quoted or single-quoted key; null when the line is not one. */
function keyValue(line) {
    const m = /^(?:"([^"]*)"|'([^']*)'|([^\s"'#:{}[\],&*!|>-][^:#]*?|<<))\s*:(?:\s+(.*))?$/.exec(stripComment(line).trim());
    if (!m)
        return null;
    return { key: (m[1] ?? m[2] ?? m[3] ?? "").trim(), value: (m[4] ?? "").trim() };
}
/** Classify an inline value: nothing (a block follows), a scalar, a one-line flow collection, or a shape not read. */
function inlineValue(raw) {
    let v = raw.trim();
    // An anchor names the value that follows it; the value is still read.
    const anchor = /^&\S+(?:\s+(.*))?$/.exec(v);
    if (anchor)
        v = (anchor[1] ?? "").trim();
    if (v === "")
        return { kind: "block" };
    // Block scalars, aliases and tags are not read.
    if (/^[|>*!]/.test(v))
        return { kind: "unknown" };
    if (v.startsWith("{") || v.startsWith("[")) {
        const items = flowItems(v);
        return items === null ? { kind: "unknown" } : { kind: "flow", open: v[0], items };
    }
    return { kind: "scalar", text: unquote(v) };
}
/**
 * The top-level items of a flow collection written whole on one line, split at
 * commas outside nested brackets and quotes; null when it does not close at
 * the end of the line (a flow value spread over lines is not read).
 */
function flowItems(v) {
    const items = [];
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let start = 1;
    for (let i = 0; i < v.length; i++) {
        const c = v[i];
        if (c === "'" && !inDouble)
            inSingle = !inSingle;
        else if (c === '"' && !inSingle)
            inDouble = !inDouble;
        else if (inSingle || inDouble)
            continue;
        else if (c === "{" || c === "[")
            depth++;
        else if (c === "}" || c === "]") {
            depth--;
            if (depth === 0) {
                if (i !== v.length - 1)
                    return null;
                items.push(v.slice(start, i));
            }
        }
        else if (c === "," && depth === 1) {
            items.push(v.slice(start, i));
            start = i + 1;
        }
    }
    if (depth !== 0)
        return null;
    return items.map((s) => s.trim()).filter((s) => s.length > 0);
}
/** The key of a flow-map item (`key: value`, or a bare `key`), or null when it is not one. */
function flowKey(item) {
    if (!/:(?:\s|$)/.test(item))
        return /^[^{}[\],:*&!]+$/.test(item) ? { key: unquote(item), value: "" } : null;
    return keyValue(item);
}
/** Trigger names from an `on:` value and the block under it; null when the shape is not read. */
function triggersOf(raw, block) {
    const v = inlineValue(raw);
    const triggers = new Set();
    if (v.kind === "unknown")
        return null;
    if (v.kind === "scalar")
        return triggers.add(v.text);
    if (v.kind === "flow") {
        for (const item of v.items) {
            if (v.open === "[") {
                if (/^[{[*&!|>]/.test(item))
                    return null;
                triggers.add(unquote(item));
            }
            else {
                const kv = flowKey(item);
                if (!kv || kv.key === "<<")
                    return null;
                triggers.add(kv.key);
            }
        }
        return triggers;
    }
    // A block: either `- name` list items or `name:` map keys, at the shallowest indent.
    const base = baseIndent(block);
    if (base === null)
        return null;
    for (const line of block) {
        if (indentOf(line) !== base)
            continue;
        const s = stripComment(line).trim();
        const li = /^-\s+(.+)$/.exec(s);
        if (li) {
            const item = li[1].trim();
            if (/^[{[*&!|>]/.test(item))
                return null;
            triggers.add(unquote(item.replace(/:$/, "")));
            continue;
        }
        const kv = keyValue(s);
        if (!kv || kv.key === "<<")
            return null;
        triggers.add(kv.key);
    }
    return triggers;
}
/** The grant a `checks` value gives. */
function checksValue(raw) {
    const v = inlineValue(raw);
    if (v.kind !== "scalar")
        return "unknown";
    if (v.text === "write")
        return "granted";
    if (v.text === "read" || v.text === "none")
        return "none";
    return "unknown";
}
/** Read one `permissions:` value (inline and the block under it) for checks: write. */
function permissionsGrant(raw, block) {
    const v = inlineValue(raw);
    if (v.kind === "unknown")
        return "unknown";
    if (v.kind === "scalar") {
        if (v.text === "write-all")
            return "granted";
        if (v.text === "read-all")
            return "none";
        return "unknown";
    }
    if (v.kind === "flow") {
        if (v.open === "[")
            return "unknown";
        for (const item of v.items) {
            const kv = flowKey(item);
            if (!kv || kv.key === "<<")
                return "unknown";
            if (kv.key === "checks")
                return checksValue(kv.value);
        }
        return "none";
    }
    const base = baseIndent(block);
    if (base === null)
        return "unknown";
    for (const line of block) {
        if (indentOf(line) !== base)
            continue;
        const kv = keyValue(line);
        if (!kv || kv.key === "<<")
            return "unknown";
        if (kv.key === "checks")
            return checksValue(kv.value);
    }
    return "none";
}
/** The most permissive of several grants: granted, then unknown, then default, then none. */
function strongest(grants) {
    for (const g of ["granted", "unknown", "default"])
        if (grants.includes(g))
            return g;
    return "none";
}
export function scanWorkflow(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let triggers = new Set();
    let topPermissions = "absent";
    const jobGrants = [];
    for (let i = 0; i < lines.length; i++) {
        if (indentOf(lines[i]) !== 0)
            continue;
        const kv = keyValue(lines[i]);
        if (!kv)
            continue;
        const block = blockLines(lines, i + 1, 0);
        if (kv.key === "on") {
            const t = triggersOf(kv.value, block);
            if (t === null || triggers === null)
                triggers = null;
            else
                for (const name of t)
                    triggers.add(name);
        }
        else if (kv.key === "permissions") {
            topPermissions = permissionsGrant(kv.value, block);
        }
        else if (kv.key === "jobs") {
            if (inlineValue(kv.value).kind !== "block") {
                jobGrants.push("unknown");
                continue;
            }
            // Each job is a key one level under `jobs:`; its `permissions:` overrides the workflow's.
            const jobIndent = baseIndent(block);
            if (jobIndent === null)
                continue;
            for (let j = i + 1; j < lines.length; j++) {
                const ind = indentOf(lines[j]);
                if (ind === 0)
                    break;
                if (ind !== jobIndent)
                    continue;
                const job = keyValue(lines[j]);
                if (!job || job.key === "<<" || inlineValue(job.value).kind !== "block") {
                    jobGrants.push("unknown");
                    continue;
                }
                const jobBlock = blockLines(lines, j + 1, jobIndent);
                const subBase = baseIndent(jobBlock);
                let jobPerm = "absent";
                for (let k = 0; k < jobBlock.length; k++) {
                    const bl = jobBlock[k];
                    if (indentOf(bl) !== subBase)
                        continue;
                    const pk = keyValue(bl);
                    if (pk?.key === "<<")
                        jobPerm = "unknown";
                    if (pk?.key === "permissions") {
                        jobPerm = permissionsGrant(pk.value, blockLines(jobBlock, k + 1, subBase));
                        break;
                    }
                }
                jobGrants.push(jobPerm);
            }
        }
    }
    const pullRequest = triggers === null ? null : [...triggers].some((t) => PR_TRIGGERS.has(t));
    // Effective grant: a job uses its own permissions, else the workflow's, else the repository default.
    const fallback = topPermissions === "absent" ? "default" : topPermissions;
    const effective = jobGrants.length === 0 ? [fallback] : jobGrants.map((g) => (g === "absent" ? fallback : g));
    return { pullRequest, checksWrite: strongest(effective) };
}
