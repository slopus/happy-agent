import type { AnyAgentTool } from "@slopus/happy-agent-base";

import type { Compute } from "../Compute.js";
import type { ComputeToolVendor } from "../ComputeToolVendor.js";
import type { FileReadLog } from "../../impl/FileReadLog.js";
import { assembleClaudeComputeTools } from "./claude/assembleClaudeComputeTools.js";
import { assembleCodexComputeTools } from "./codex/assembleCodexComputeTools.js";
import { assembleGrokComputeTools } from "./grok/assembleGrokComputeTools.js";
import { assembleKimiComputeTools } from "./kimi/assembleKimiComputeTools.js";
import { assembleGlmComputeTools } from "./glm/assembleGlmComputeTools.js";

/**
 * The one place a machine becomes a tool surface.
 *
 * Each vendor's array is fixed and written out in that vendor's own order; this only chooses
 * between them. Nothing here inspects a tool name, asks a provider what it supports, or filters
 * a list — a model's behavior is the array it was given, and that array is decided once, here.
 */
export function assembleComputeTools(
    vendor: ComputeToolVendor,
    compute: Compute,
    reads: FileReadLog,
): readonly AnyAgentTool[] {
    switch (vendor) {
        case "claude":
            return assembleClaudeComputeTools(compute, reads);
        case "codex":
            return assembleCodexComputeTools(compute, reads);
        case "grok":
            return assembleGrokComputeTools(compute, reads);
        case "kimi":
            return assembleKimiComputeTools(compute, reads);
        case "glm":
            return assembleGlmComputeTools(compute, reads);
    }
}
