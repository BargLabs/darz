// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Barg Labs
export const CHECK_IDS = [
    "gate_files_owned",
    "human_review_required",
    "writer_not_approver",
    "agents_cannot_bypass",
    "required_checks_fail_closed",
    "agent_merges_touching_gates",
];
export const CHECK_TITLES = {
    gate_files_owned: "Gate files are owned and code-owner review is required",
    human_review_required: "A human review is required, stale approvals are dismissed, and the last push is approved by someone else",
    writer_not_approver: "The writer is never the approver",
    agents_cannot_bypass: "Agents cannot bypass the rules or administer the repository",
    required_checks_fail_closed: "At least one status check is required",
    agent_merges_touching_gates: "Recent merges by agent identities that changed gate files",
};
