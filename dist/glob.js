// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
/**
 * Translate a path glob into a regular expression body.
 *   `**` followed by `/`  any number of whole directories, including none
 *   `**`                  anything, across directories
 *   `*`                   anything within one path segment
 *   `?`                   one character within a path segment
 * Everything else is literal. Matching is case sensitive.
 */
export function globBody(glob) {
    let out = "";
    let i = 0;
    while (i < glob.length) {
        const c = glob[i];
        if (c === "*") {
            if (glob[i + 1] === "*") {
                if (glob[i + 2] === "/") {
                    out += "(?:.*/)?";
                    i += 3;
                    continue;
                }
                out += ".*";
                i += 2;
                continue;
            }
            out += "[^/]*";
            i += 1;
            continue;
        }
        if (c === "?") {
            out += "[^/]";
            i += 1;
            continue;
        }
        out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
        i += 1;
    }
    return out;
}
