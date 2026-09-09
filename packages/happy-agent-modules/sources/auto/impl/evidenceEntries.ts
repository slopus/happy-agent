import type { AgentMessageMetadata, AgentBaseToolOutcome } from "@slopus/happy-agent-base";
import type { SessionOutputBlock, SessionUserMessage } from "@slopus/happy-providers";

import type { AutoEvidenceEntry } from "../AutoReviewTranscript.js";
import { isUserOriginMetadata } from "../../impl/messageOrigin.js";
import type { AutoTranscriptMessage } from "./createAutoPermissionTranscript.js";

/**
 * Pure classifiers that turn one base-hook observation into a stored evidence entry.
 *
 * These run where a message's provenance and the human-owned portion of an interactive answer still
 * exist — the base hooks, not the lossy public history — and they produce the exact message-shaped
 * view `createAutoPermissionTranscript` reclassifies. Keeping them pure is what lets the trust
 * decision be tested directly: an agent-authored collaboration message, a direct user shell result,
 * and an ordinary human message must land as untrusted, untrusted, and trusted respectively, and a
 * model-authored question must never be mistaken for a user answer.
 *
 * The denormalized `category` and `trustedUserEvidence` fields the store keeps are computed the same
 * way here; the pure transcript builder remains the single authority on the final budgeted output.
 */

/** A queued user message, classified by its provenance into trusted or untrusted evidence. */
export function userMessageEvidence(
    message: SessionUserMessage,
    metadata: AgentMessageMetadata | undefined,
): AutoEvidenceEntry | undefined {
    if (isHiddenFromUser(metadata)) return undefined;
    const blocks = inputBlocks(message.content);
    const shell = isShellCommand(blocks);
    // Trust is granted only by a positive marker of human origin, never inferred from missing
    // metadata. A genuine end-user submission is stamped `messageOrigin: "user"`; everything the
    // system generates on the agent's behalf — a goal continuation, a collaboration hand-off, an
    // agent answering another agent — is not, and neither is an unstamped message. Anything that is
    // not a marked human message is recorded as an agent-originated entry so the builder renders it
    // as untrusted context, closing the forgery path where an agent manufactures its own
    // authorization. A direct user shell command is tool output regardless of who surfaced it.
    const humanOrigin = isUserOriginMetadata(metadata);
    const entry: AutoTranscriptMessage = {
        role: "user",
        blocks,
        ...(humanOrigin ? {} : { provenance: "agent" as const }),
    };
    const trusted = humanOrigin && !shell;
    return {
        category: shell ? "tool" : "message",
        entry,
        trustedUserEvidence: trusted,
        trustedUserEvidenceTruncated: false,
    };
}

/** One completed assistant text block, always untrusted. */
export function assistantTextEvidence(text: string): AutoEvidenceEntry {
    return untrustedAgentEntry("message", { role: "agent", blocks: [{ type: "text", text }] });
}

/** One completed assistant tool call, always untrusted. */
export function assistantToolCallEvidence(name: string, argumentsJson: string): AutoEvidenceEntry {
    return untrustedAgentEntry("message", {
        role: "agent",
        blocks: [{ type: "tool_call", name, arguments: parseArguments(argumentsJson) }],
    });
}

/**
 * One tool result. An ordinary result is untrusted tool output; a result carrying the human-owned
 * answer to an interactive request is trusted `User response through …` evidence, and only that
 * portion is trusted. The tool's string name never decides this — the caller passes the recorded
 * user answer when, and only when, it was a genuine answered user-input request.
 */
export function toolResultEvidence(options: {
    toolName: string;
    content: readonly SessionOutputBlock[];
    isError: boolean;
    trustedUserAnswer?: readonly { readonly type: "text"; readonly text: string }[];
}): AutoEvidenceEntry {
    const { toolName, content, isError, trustedUserAnswer } = options;
    const rendered = outputBlocks(content);
    const trusted = trustedUserAnswer !== undefined;
    const entry: AutoTranscriptMessage = {
        role: "agent",
        blocks: [
            {
                type: "tool_result",
                toolName,
                rendered,
                isError,
                ...(trustedUserAnswer === undefined
                    ? {}
                    : { trustedUserEvidence: [...trustedUserAnswer] }),
            },
        ],
    };
    return {
        category: trusted ? "message" : "tool",
        entry,
        trustedUserEvidence: trusted,
        trustedUserEvidenceTruncated: false,
    };
}

/** A provider retry or run error, kept as untrusted context; display-only errors are not stored. */
export function errorEvidence(text: string, retried: boolean): AutoEvidenceEntry {
    return untrustedAgentEntry("message", {
        role: "error",
        blocks: [{ type: "text", text }],
        ...(retried ? { outcome: "retried" as const } : {}),
    });
}

/** The tool name off a base outcome, namespaced exactly as the model saw it. */
export function outcomeToolName(outcome: AgentBaseToolOutcome): string {
    const tool = outcome.tool;
    return tool.namespace === undefined ? tool.name : `${tool.namespace}/${tool.name}`;
}

function untrustedAgentEntry(
    category: "message" | "tool",
    entry: AutoTranscriptMessage,
): AutoEvidenceEntry {
    return { category, entry, trustedUserEvidence: false, trustedUserEvidenceTruncated: false };
}

function inputBlocks(content: SessionUserMessage["content"]): AutoTranscriptMessage["blocks"] {
    return content.map((block) => {
        if (block.type === "tool_call_request") return structuredClone(block);
        return block.type === "text"
            ? { type: "text" as const, text: block.text }
            : { type: "image" as const };
    });
}

function outputBlocks(
    content: readonly SessionOutputBlock[],
): { type: "text"; text: string }[] | { type: "image" }[] {
    return content.map((block) =>
        block.type === "text"
            ? { type: "text" as const, text: block.text }
            : { type: "image" as const },
    ) as { type: "text"; text: string }[];
}

function isHiddenFromUser(metadata: AgentMessageMetadata | undefined): boolean {
    return metadata?.hideFromUser === true;
}

function isShellCommand(blocks: AutoTranscriptMessage["blocks"]): boolean {
    if (blocks.length === 0 || blocks.some((block) => block.type !== "text")) return false;
    const text = blocks
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trimStart();
    return text.startsWith("<user_shell_command>");
}

function parseArguments(argumentsJson: string): unknown {
    try {
        return JSON.parse(argumentsJson);
    } catch {
        return argumentsJson;
    }
}
