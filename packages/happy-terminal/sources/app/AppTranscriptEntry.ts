import type { ProviderError, ToolPermission, Usage } from "../protocol/index.js";

import type {
    BackgroundTerminalInteractionPresentation,
    ExecCommandPresentation,
    FileDiff,
} from "../protocol/index.js";
import type { ExplorationToolCallPresentation } from "../protocol/index.js";
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
    /** Public automatic-review result and whether this call received temporary Full access. */
    toolPermission?: ToolPermission;
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
