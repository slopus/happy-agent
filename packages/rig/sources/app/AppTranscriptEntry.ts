import type { ProviderError, Usage } from "../protocol/index.js";

import type {
    BackgroundTerminalInteractionPresentation,
    ExecCommandPresentation,
    FileDiff,
} from "../agent/ToolResultPresentation.js";
import type { ExplorationToolCallPresentation } from "../agent/ToolCallPresentation.js";
import type { CodexMcpToolCall } from "./CodexMcpToolCall.js";
import type { CompletedTurn } from "./CompletedTurn.js";
import type { NoticeChild } from "./NoticeChild.js";

export type AppTranscriptRole =
    | "system"
    | "user"
    | "assistant"
    | "thinking"
    | "tool"
    | "event"
    | "error";

export interface AppTranscriptEntry {
    backgroundTerminalCompletion?: string;
    backgroundTerminalInteraction?: BackgroundTerminalInteractionPresentation;
    childText?: boolean;
    completedTurn?: CompletedTurn;
    contextOnly?: true;
    execCommand?: ExecCommandPresentation;
    exploration?: ExplorationToolCallPresentation;
    fileDiffs?: readonly FileDiff[];
    omittedFileDiffs?: number;
    id: string;
    mcpToolCall?: CodexMcpToolCall;
    noticeChildren?: readonly NoticeChild[];
    permissionReview?: string;
    /** Structured provider failure used to keep reset countdowns live. */
    providerError?: ProviderError;
    providerErrorFallback?: string;
    providerErrorProviderId?: string;
    role: AppTranscriptRole;
    text: string;
    detail?: string;
    title?: string;
    turnElapsedMs?: number;
    turnUsage?: Usage;
}
