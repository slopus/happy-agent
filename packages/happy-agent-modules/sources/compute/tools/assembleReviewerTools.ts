import type { AnyAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../Compute.js";
import type { ComputeToolVendor } from "../ComputeToolVendor.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { assembleClaudeReviewerTools } from "./claude/assembleClaudeReviewerTools.js";
import { assembleCodexReviewerTools } from "./codex/assembleCodexReviewerTools.js";
import { assembleGrokReviewerTools } from "./grok/assembleGrokReviewerTools.js";

/**
 * The one place the automatic permission reviewer becomes a tool surface.
 *
 * Happy Agent v1 gave its review side agent its own provider's tools — a Claude review got Claude's tools, a
 * Codex review got Codex's — so the model saw the names it was trained on. This does the same: the
 * vendor is the vendor of the reviewer's own model route, chosen the moment the reviewer assembles
 * its tools for an inference, not the vendor of the agent under review. Each vendor's read-only
 * array is fixed and written out in that vendor's own order; this only chooses between them. Nothing
 * here inspects a tool name, asks a provider what it supports, or filters a larger list — a
 * reviewer's behavior is the array it was given, and that array is decided once.
 */
export function assembleReviewerTools(
    vendor: ComputeToolVendor,
    compute: Compute,
    reads: FileReadLog,
): readonly AnyAgentTool[] {
    switch (vendor) {
        case "claude":
            return assembleClaudeReviewerTools(compute, reads);
        case "codex":
            return assembleCodexReviewerTools(compute);
        case "grok":
            return assembleGrokReviewerTools(compute, reads);
    }
}
