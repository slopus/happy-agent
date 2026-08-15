/**
 * High-level types for agent transcripts and tools.
 */

import type { Static, TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";
import type { Model } from "@slopus/happy-agent-base";
import type { SessionAssistantMessage, SessionProviderError } from "@slopus/happy-providers";

import type { AgentContext } from "./context/AgentContext.js";
import type { ToolResultPresentation } from "./ToolResultPresentation.js";
import type { ToolCallPresentation } from "./ToolCallPresentation.js";
import type { UnansweredUserInput, UserInputResponse } from "../user-input/types.js";
import type { Attachment } from "../protocol/Attachment.js";
import type { Usage } from "../protocol/InferenceProtocol.js";
import type { ServiceNotice } from "../protocol/ServiceNotice.js";

/** Plain text content. */
export interface TextBlock {
    type: "text";
    text: string;
}

/** Image content, typically as base64 or a URL depending on provider. */
export interface ImageBlock {
    type: "image";
    mediaType: string;
    data: string;
    detail?: "high" | "original";
}

/** Blocks allowed on system and user messages. */
export type ContentBlock = TextBlock | ImageBlock;

/** Model reasoning content returned by providers that expose thinking blocks. */
export interface ThinkingBlock {
    type: "thinking";
    thinking: string;
    encrypted?: string;
    redacted?: boolean;
}

/** A model-requested tool invocation embedded in a message. */
export interface ToolCallBlock {
    type: "tool_call";
    /** Globally unique identifier owned by Rig. */
    id: string;
    /** Original identifier emitted by the provider and replayed on the provider wire. */
    providerToolCallId?: string;
    name: string;
    namespace?: string;
    arguments: unknown;
    /** The provider stopped before this call became executable. */
    incomplete?: boolean;
    kind?: "custom" | "function";
    /** Opaque provider metadata required to replay this call faithfully. */
    vendor?: unknown;
    /** Durable model-invisible data defined by the tool for rich transcript rendering. */
    presentation?: ToolCallPresentation;
}

/** Result of executing a tool call, embedded in an agent message. */
export interface ToolResultFailure {
    kind: "execution_failed" | "interrupted" | "invalid_arguments" | "tool_unavailable";
    /** Human-readable cause for failures whose display includes tool-specific context. */
    message?: string;
}

export interface ToolResultBlock {
    type: "tool_result";
    /** Globally unique Rig identifier of the matching tool call. */
    toolCallId: string;
    /** Original identifier replayed when returning this result to the provider. */
    providerToolCallId?: string;
    toolName: string;
    /** Rendered tool answer produced by the tool's `toLLM` serializer. */
    rendered: readonly ContentBlock[];
    /** Short human-facing tool summary produced by the tool's `toUI` serializer. */
    display: string;
    isError?: boolean;
    /** Stable failure state used by transcript rendering without parsing display text. */
    failure?: ToolResultFailure;
    /** Durable model-invisible data used for rich transcript rendering. */
    presentation?: ToolResultPresentation;
    /** Exact user-authored or user-selected content that Auto review may trust. */
    trustedUserEvidence?: readonly ContentBlock[];
    /** Opaque provider metadata copied from the originating tool call. */
    vendor?: unknown;
}

/** Blocks allowed on agent messages. */
export type AgentBlock = ContentBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock;

export interface SystemMessage {
    role: "system";
    id: string;
    blocks: readonly ContentBlock[];
    /** Visible service metadata that clients may render more richly than the fallback blocks. */
    structured?: ServiceNotice;
    /** Visible service notices that must not become model context use this value. */
    context?: "excluded";
    /** Durable model context that must never be presented as transcript content. */
    internal?: true;
}

export interface UserMessage {
    role: "user";
    id: string;
    blocks: readonly ContentBlock[];
    /** Stable human profile identity, or null for an unattributed local message. */
    identity?: string | null;
    /** Background context that waits for the next actionable user message. */
    contextOnly?: true;
    /** Durable origin for non-human messages that use a user-role provider input shape. */
    provenance?: "agent";
    /**
     * Names the command this message is the output of, when the user ran one.
     *
     * The blocks of such a message are the command's own stdout and stderr
     * rather than anything a person wrote.
     */
    shellCommandId?: string;
    /** Durable sender identity for rendering and navigating agent-authored messages. */
    agentSource?: {
        /** Stable agent capability ID used for replies. */
        agentId: string;
        /** Stable Rig session ID of the chat that sent this message. */
        sessionId: string;
        /** Sender title captured when the message was sent. */
        title?: string;
    };
    /** Opaque provider-reviewed payload delivered between Codex agents. */
    encryptedAgentMessage?: {
        author: string;
        recipient: string;
        header: string;
        encryptedContent: string;
    };
    /** Whether this agent-authored message starts a new inference turn. */
    agentMessageTriggerTurn?: boolean;
    /** Durable model context that must never be presented as user-authored content. */
    internal?: true;
    /** Marks a durable record of the project instructions the model has been given. */
    agentsMd?: {
        /** Fingerprint of the instructions, or null once they were deleted from disk. */
        fingerprint: string | null;
    };
}

export interface CompactionMessage {
    role: "compaction";
    id: string;
    blocks: readonly ContentBlock[];
    /** Messages removed from the model context by this compaction. */
    replacedMessageIds: readonly string[];
    statistics: {
        before: { exact: true; tokens: number };
        after: { exact: boolean; tokens: number };
    };
    /** Provider that owns this replacement context. */
    providerId: string;
    /**
     * Complete provider-authored replacement context. Present only on the private model-context
     * copy; the visible transcript copy deliberately does not expose provider-native payloads.
     */
    replacementMessages?: readonly unknown[];
    /** Model requested for the compaction inference. */
    requestedModelId?: string;
    /** Provider-reported model that performed the compaction inference. */
    responseModel?: string;
    /** Provider-reported usage spent producing this compaction. */
    usage?: Usage;
    /** Compaction is durable visible history and can never be hidden as internal context. */
    internal?: never;
}

/** A failure preserved in visible history. */
export interface ErrorMessage {
    role: "error";
    id: string;
    blocks: readonly ContentBlock[];
    /** Whether Rig retried inference, continued after a local failure, or stopped. */
    outcome: "retried" | "continued" | "failed";
    /** Present when the provider identified which retry attempt failed. */
    attempt?: number;
    /** Durable inference attribution for provider failures. */
    providerId?: string;
    requestedModelId?: string;
    /** Bounded provider-native diagnostics retained for support and debugging. */
    providerError?: SessionProviderError;
    /**
     * Display-only failures duplicate information already represented in model context, such as
     * an automatic permission denial that is also the tool result.
     */
    context?: "excluded";
    /** Failures are always visible transcript history. */
    internal?: never;
}

export interface AgentMessage {
    role: "agent";
    id: string;
    blocks: readonly AgentBlock[];
    /** Model-invisible files and links prepared for application rendering after turn completion. */
    attachments?: readonly Attachment[];
    /** Provider-reported usage for inference messages. Tool-result messages omit it. */
    usage?: Usage;
    /** Context window occupied immediately after this inference. */
    contextTokens?: number;
    /** Durable inference attribution. Tool-result messages omit these fields. */
    providerId?: string;
    requestedModelId?: string;
    responseModel?: string;
    /** Exact ordered provider blocks retained for replay. */
    sessionMessage?: SessionAssistantMessage;
    /** Durable model context that must never be presented as transcript content. */
    internal?: true;
}

export type Message = SystemMessage | UserMessage | AgentMessage | CompactionMessage | ErrorMessage;

/** A message that can be handed to a run already in progress. */
export type SteeringMessage = SystemMessage | UserMessage;

/** A fixed lock key shared across all invocations. */
export type LockConstant = string;

/** A lock key derived from the invocation arguments. */
export type LockForArgs<TArgs> = (args: TArgs) => string;

/** Locks applied before a tool executes. Each key shares a concurrency budget. */
export type Lock<TArgs> = LockConstant | LockForArgs<TArgs>;

/** A fully typed tool with execution, LLM serialization, and concurrency control. */
export interface ToolExecutionOptions {
    /** Runtime context for this concrete tool invocation. */
    ctx: Context;
    /** Canonical model context immediately before this tool invocation. */
    messages?: readonly Message[];
    /** Model selected for the active agent turn. */
    model?: Model;
    onProgress?: (display: string) => void;
    /** Reports a short ephemeral activity label while the tool remains active. */
    onStatus?: (status: string) => void;
    signal?: AbortSignal;
    /** Original identifier emitted by the provider for this tool call. */
    providerToolCallId?: string;
    toolBatchId?: string;
    toolCallId?: string;
    toolCallIndex?: number;
}

export type AutoPermissionPredicate<TArgs> = (
    args: TArgs,
    context: AgentContext,
) => boolean | Promise<boolean>;

export type AutoPermissionActionDescriber<TArgs> = (args: TArgs, context: AgentContext) => string;

export interface ToolNamespace {
    name: string;
    description: string;
}

export interface DefinedTool<
    TArgsSchema extends TSchema = TSchema,
    TReturnSchema extends TSchema = TSchema,
> {
    name: string;
    label: string;
    description: string;
    /** Keep this tool out of the initial prompt when the provider supports native tool search. */
    deferLoading?: boolean;
    /** Provider-facing namespace containing this tool. */
    namespace?: ToolNamespace;
    arguments: TArgsSchema;
    returnType: TReturnSchema;
    /** Durable tools form a barrier after immediate calls in the same model batch. */
    execution: "immediate" | "durable";
    /** Abort this tool, without aborting the turn, when new steering is scheduled. */
    steerable: boolean;
    execute: (
        args: Static<TArgsSchema>,
        context: AgentContext,
        options: ToolExecutionOptions,
    ) => Promise<Static<TReturnSchema>> | Static<TReturnSchema>;
    resolveUserInput?: (
        response: UserInputResponse,
        args: Static<TArgsSchema>,
    ) => Static<TReturnSchema>;
    resolveUnansweredUserInput?: (
        outcome: UnansweredUserInput,
        args: Static<TArgsSchema>,
    ) => Static<TReturnSchema>;
    isError?: (result: Static<TReturnSchema>) => boolean;
    toLLM: (result: Static<TReturnSchema>) => readonly ContentBlock[];
    toCallPresentation?: (
        args: Static<TArgsSchema>,
        context: AgentContext,
    ) => ToolCallPresentation | undefined;
    toPresentation?: (
        result: Static<TReturnSchema>,
        args: Static<TArgsSchema>,
    ) => ToolResultPresentation | undefined;
    toTrustedUserEvidence?: (
        result: Static<TReturnSchema>,
        args: Static<TArgsSchema>,
    ) => readonly ContentBlock[];
    toUI: (result: Static<TReturnSchema>, args: Static<TArgsSchema>) => string;
    /** Model- and user-facing result text when the tool invocation is interrupted. */
    interruptionMessage?: string;
    /** Provider-specific Auto-mode guidance included only while this tool is active. */
    autoPermissionInstructions?: string;
    /** Offered to the read-only side agent that reviews Auto permission decisions. */
    availableToPermissionReviewer: boolean;
    /** Describes the exact reviewed boundary in permission events and refusal results. */
    describeAutoPermissionAction?: AutoPermissionActionDescriber<Static<TArgsSchema>>;
    requiresAutoOrFullAccess: boolean;
    shouldReviewInAutoMode: AutoPermissionPredicate<Static<TArgsSchema>>;
    shouldRunInFullAccessInAutoMode: AutoPermissionPredicate<Static<TArgsSchema>>;
    /** Locks acquired for each invocation; constants or argument-derived keys. */
    locks: readonly Lock<Static<TArgsSchema>>[];
}

export interface AnyDefinedTool {
    name: string;
    label: string;
    description: string;
    deferLoading?: boolean;
    namespace?: ToolNamespace;
    arguments: TSchema;
    returnType: TSchema;
    execution: "immediate" | "durable";
    /** Abort this tool, without aborting the turn, when new steering is scheduled. */
    steerable: boolean;
    execute: (
        args: never,
        context: AgentContext,
        options: ToolExecutionOptions,
    ) => Promise<unknown> | unknown;
    resolveUserInput?: (response: UserInputResponse, args: never) => unknown;
    resolveUnansweredUserInput?: (outcome: UnansweredUserInput, args: never) => unknown;
    isError?: (result: never) => boolean;
    toLLM: (result: never) => readonly ContentBlock[];
    toCallPresentation?: (args: never, context: AgentContext) => ToolCallPresentation | undefined;
    toPresentation?: (result: never, args: never) => ToolResultPresentation | undefined;
    toTrustedUserEvidence?: (result: never, args: never) => readonly ContentBlock[];
    toUI: (result: never, args: never) => string;
    interruptionMessage?: string;
    autoPermissionInstructions?: string;
    availableToPermissionReviewer: boolean;
    describeAutoPermissionAction?: AutoPermissionActionDescriber<never>;
    requiresAutoOrFullAccess: boolean;
    shouldReviewInAutoMode: AutoPermissionPredicate<never>;
    shouldRunInFullAccessInAutoMode: AutoPermissionPredicate<never>;
    locks: readonly Lock<never>[];
}

export type InferToolArgs<T extends AnyDefinedTool> =
    T extends DefinedTool<infer TArgsSchema extends TSchema, TSchema> ? Static<TArgsSchema> : never;

export type InferToolReturn<T extends AnyDefinedTool> =
    T extends DefinedTool<TSchema, infer TReturnSchema extends TSchema>
        ? Static<TReturnSchema>
        : never;

/** Marks one member of a fixed tool array for provider-native deferred loading. */
export function deferToolLoading<T extends AnyDefinedTool>(tool: T): T & { deferLoading: true } {
    return { ...tool, deferLoading: true };
}

/** Define a tool with TypeBox-inferred argument and return types. */
export function defineTool<
    const TArgsSchema extends TSchema,
    const TReturnSchema extends TSchema,
>(tool: {
    name: string;
    label: string;
    description: string;
    deferLoading?: boolean;
    namespace?: ToolNamespace;
    arguments: TArgsSchema;
    returnType: TReturnSchema;
    execute: (
        args: Static<TArgsSchema>,
        context: AgentContext,
        options: ToolExecutionOptions,
    ) => Promise<Static<TReturnSchema>> | Static<TReturnSchema>;
    resolveUserInput?: (
        response: UserInputResponse,
        args: Static<TArgsSchema>,
    ) => Static<TReturnSchema>;
    resolveUnansweredUserInput?: (
        outcome: UnansweredUserInput,
        args: Static<TArgsSchema>,
    ) => Static<TReturnSchema>;
    isError?: (result: Static<TReturnSchema>) => boolean;
    toLLM: (result: Static<TReturnSchema>) => readonly ContentBlock[];
    toCallPresentation?: (
        args: Static<TArgsSchema>,
        context: AgentContext,
    ) => ToolCallPresentation | undefined;
    toPresentation?: (
        result: Static<TReturnSchema>,
        args: Static<TArgsSchema>,
    ) => ToolResultPresentation | undefined;
    toTrustedUserEvidence?: (
        result: Static<TReturnSchema>,
        args: Static<TArgsSchema>,
    ) => readonly ContentBlock[];
    toUI: (result: Static<TReturnSchema>, args: Static<TArgsSchema>) => string;
    interruptionMessage?: string;
    autoPermissionInstructions?: string;
    availableToPermissionReviewer?: boolean;
    describeAutoPermissionAction?: AutoPermissionActionDescriber<Static<TArgsSchema>>;
    requiresAutoOrFullAccess?: boolean;
    execution?: "immediate" | "durable";
    steerable?: boolean;
    shouldReviewInAutoMode: AutoPermissionPredicate<Static<TArgsSchema>>;
    shouldRunInFullAccessInAutoMode?: AutoPermissionPredicate<Static<TArgsSchema>>;
    locks: readonly Lock<Static<TArgsSchema>>[];
}): DefinedTool<TArgsSchema, TReturnSchema> {
    return {
        ...tool,
        execution: tool.execution ?? "immediate",
        steerable: tool.steerable ?? false,
        availableToPermissionReviewer: tool.availableToPermissionReviewer ?? false,
        requiresAutoOrFullAccess: tool.requiresAutoOrFullAccess ?? false,
        shouldRunInFullAccessInAutoMode: tool.shouldRunInFullAccessInAutoMode ?? (() => false),
    };
}
