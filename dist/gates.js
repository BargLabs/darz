// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
import { CODEOWNERS_LOCATIONS } from "./codeowners.js";
import { globBody } from "./glob.js";
/**
 * The files that judge an agent's work: CI and actions, test configuration,
 * coverage configuration and Darz lessons. The CODEOWNERS file in use is added by the
 * caller, as is Darz's own configuration file.
 */
export const DEFAULT_GATE_PATTERNS = [
    ".github/workflows/**",
    ".github/actions/**",
    "**/jest.config.*",
    "**/vitest.config.*",
    "**/vitest.workspace.*",
    "**/playwright.config.*",
    "**/karma.conf.*",
    "**/.mocharc*",
    "**/pytest.ini",
    "**/tox.ini",
    "**/noxfile.py",
    "**/conftest.py",
    "**/phpunit.xml*",
    "**/.nycrc*",
    "**/codecov.yml",
    "**/.codecov.yml",
    "**/.coveragerc",
    "**/sonar-project.properties",
    ".github/darz/lessons/**",
];
export const DARZ_CONFIG_PATH = ".github/darz.json";
const cache = new Map();
/** An anchored path glob: the whole path must match. */
export function globMatches(glob, path) {
    let re = cache.get(glob);
    if (!re) {
        re = new RegExp(`^${globBody(glob.replace(/^\/+/, ""))}$`);
        cache.set(glob, re);
    }
    return re.test(path);
}
/**
 * Files that are gate files only when they hold test or coverage settings.
 * Counting every package.json would make every dependency bump a gate change;
 * Darz reads each candidate and counts it only if it configures tests.
 */
export const CANDIDATE_GATE_PATTERNS = [
    "**/package.json",
    "**/vite.config.*",
    "**/pyproject.toml",
    "**/setup.cfg",
];
/**
 * Darz reads at most this many distinct candidate files (one GET each); more
 * makes the inventory incomplete. The bound is set by GitHub's rate limits: a
 * GITHUB_TOKEN in Actions gets 1,000 REST requests per hour per repository,
 * and a run at the default settings makes about 50 to 150 other GETs. 500
 * reads leave room for those, and stay under the secondary limit of 900 REST
 * points a minute even if every read lands in the same minute.
 */
export const MAX_CANDIDATE_READS = 500;
/**
 * Installed dependencies: package managers install into node_modules, and
 * pytest, Jest and Vitest skip it by default. A dependency's test settings
 * are not the repository's, so a committed node_modules is not read.
 */
const SKIPPED_SEGMENT = "node_modules";
/**
 * Check 6 reads at most this many candidate files at merge commits in one run
 * (each a GET, plus one GET per pull request for its merge commit's parent when
 * a rename's old name needs it). Pull requests are taken newest merge first;
 * from the first one whose reads would pass the cap, none is read.
 */
export const MAX_MERGE_CANDIDATE_READS = 100;
export function isCandidatePath(path) {
    if (path.split("/").includes(SKIPPED_SEGMENT))
        return false;
    return CANDIDATE_GATE_PATTERNS.some((g) => globMatches(g, path));
}
const PACKAGE_TEST_KEYS = ["jest", "nyc", "c8", "vitest", "mocha", "ava", "tap"];
/**
 * Does this candidate hold test or coverage settings? `null` when it cannot be
 * parsed, which leaves the inventory incomplete rather than deciding either way.
 * - package.json: a script named test or coverage (test:unit, coverage-ci, ...),
 *   or a jest, nyc, c8, vitest, mocha, ava or tap block;
 * - vite.config.*: a `test:` key, quoted or not (Vitest's inline configuration);
 * - pyproject.toml: a [tool.pytest...] or [tool.coverage...] table;
 * - setup.cfg: a [tool:pytest] or [coverage:...] section.
 */
export function holdsTestSettings(path, text) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name === "package.json") {
        let pkg;
        try {
            // JSON.parse refuses a byte-order mark, which some editors write.
            pkg = JSON.parse(text.replace(/^\uFEFF/, ""));
        }
        catch {
            return null;
        }
        if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg))
            return null;
        const p = pkg;
        if (PACKAGE_TEST_KEYS.some((k) => k in p))
            return true;
        const scripts = p.scripts;
        if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
            return Object.keys(scripts).some((k) => /^(test|coverage)([:._-]|$)/i.test(k));
        }
        return false;
    }
    if (name.startsWith("vite.config."))
        return /(^|[\s{,])(test|"test"|'test')\s*:/m.test(text);
    if (name === "pyproject.toml")
        return /^\s*\[\s*tool\.(pytest|coverage)(\.|\s*\])/m.test(text);
    if (name === "setup.cfg")
        return /^\s*\[(tool:pytest|coverage:[^\]]+)\]/m.test(text);
    return false;
}
export function gateSet(extraGlobs, codeownersInUse, candidateGates = []) {
    const patterns = [...new Set([...DEFAULT_GATE_PATTERNS, ...extraGlobs])];
    const exact = [DARZ_CONFIG_PATH, ...candidateGates];
    if (codeownersInUse)
        exact.push(codeownersInUse);
    return { patterns, exact };
}
export function isGatePath(set, path) {
    return set.exact.includes(path) || set.patterns.some((g) => globMatches(g, path));
}
/**
 * For pull request file lists: any of GitHub's CODEOWNERS locations counts,
 * since adding a higher-precedence CODEOWNERS file changes ownership.
 */
export function isGatePathForChange(set, path) {
    return isGatePath(set, path) || CODEOWNERS_LOCATIONS.includes(path);
}
export function gateFilesIn(set, paths) {
    return [...new Set(paths.filter((p) => isGatePath(set, p)))].sort();
}
/**
 * Probe paths stand for files that do not exist yet but would change the gate
 * if added. Their names start with `darz-probe-` so they read as synthetic in
 * a record. A probe that exists in the tree is dropped, since the real file is
 * then judged as a gate file; ownership depends only on the path, so the
 * result is the same either way.
 */
export const PROBE_NAME = "darz-probe-new-file";
/**
 * Probes for the default gate directories, named as GitHub reads such files.
 * GitHub runs `.yml` and `.yaml` workflows and reads `action.yml` or
 * `action.yaml`, so each directory gets one probe per extension: a CODEOWNERS
 * that owns only `*.yml` leaves a new `.yaml` file unowned.
 */
const DEFAULT_DIRECTORY_PROBES = {
    ".github/workflows/**": [".github/workflows/darz-probe-new-workflow.yml", ".github/workflows/darz-probe-new-workflow.yaml"],
    ".github/actions/**": [".github/actions/darz-probe-new-action/action.yml", ".github/actions/darz-probe-new-action/action.yaml"],
    // A lesson is <id>.json, so a CODEOWNERS that owns only *.json there owns every new lesson.
    ".github/darz/lessons/**": [".github/darz/lessons/darz-probe-new-lesson.json"],
};
/**
 * New files in the gate directory a pattern names, or none when the pattern
 * has no gate directory. A default gate directory gets its fixed probes. The gate directory is the pattern's literal leading
 * directories, before the first segment with a `*` or `?`. A pattern with no
 * wildcard names one file, and one that starts with a wildcard (`**\/conftest.py`)
 * names files at any depth, so neither has a gate directory. The probe fills
 * the wildcard part: a `**` segment is dropped (or becomes the probe name when
 * last), `*` becomes the probe name and `?` becomes `z`.
 */
export function directoryProbes(pattern) {
    const glob = pattern.replace(/^\/+/, "");
    const fixed = DEFAULT_DIRECTORY_PROBES[glob];
    if (fixed !== undefined)
        return [...fixed];
    const segments = glob.split("/");
    const first = segments.findIndex((s) => /[*?]/.test(s));
    if (first <= 0)
        return [];
    const rest = [];
    segments.slice(first).forEach((s, i, all) => {
        if (s === "**") {
            if (i === all.length - 1)
                rest.push(PROBE_NAME);
            return;
        }
        rest.push(s.replace(/\*+/g, PROBE_NAME).replace(/\?/g, "z"));
    });
    const probe = [...segments.slice(0, first), ...rest].join("/");
    return rest.length > 0 && globMatches(glob, probe) ? [probe] : [];
}
/**
 * Paths that are not in the tree but would change the gate if added: each
 * CODEOWNERS location GitHub reads before the one in use (adding a file there
 * replaces it), and a new file in each gate directory. Sorted; paths present
 * in the tree are left out.
 */
export function probePaths(set, codeownersInUse, treePaths) {
    const at = CODEOWNERS_LOCATIONS.indexOf(codeownersInUse);
    const probes = new Set(at > 0 ? CODEOWNERS_LOCATIONS.slice(0, at) : []);
    for (const g of set.patterns)
        for (const p of directoryProbes(g))
            probes.add(p);
    const present = new Set(treePaths ?? []);
    return [...probes].filter((p) => !present.has(p)).sort();
}
