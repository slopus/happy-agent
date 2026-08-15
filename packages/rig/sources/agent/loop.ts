import { createId } from "@paralleldrive/cuid2";
import { Value } from "@sinclair/typebox/value";
import { extractProviderErrorDiagnostics } from "@slopus/happy-providers";
import type { Context as RuntimeContext } from "@steve.kite/stdlib";

import { assistantMessageToAgentMessage } from "./impl/assistantMessageToAgentMessage.js";
import { boundToolResultBlocks } from "./impl/boundToolResultBlocks.js";
import { createErrorToolResultBlock } from "./impl/createErrorToolResultBlock.js";
import { formatInvalidToolArguments } from "./impl/formatInvalidToolArguments.js";
import { createErrorMessage } from "./impl/createErrorMessage.js";
import { createToolResultBlock } from "./impl/createToolResultBlock.js";
import { isExcludedFromModelContext } from "./impl/isExcludedFromModelContext.js";
import type { AgentContext } from "./context/AgentContext.js";
import type { BashSessionActivity } from "./context/BashContext.js";
import { isContextWindowExceededError } from "./impl/isContextWindowExceededError.js";
import { isInvalidImageRequestError } from "./impl/isInvalidImageRequestError.js";
import { normalizeToolCallArguments } from "./impl/normalizeToolCallArguments.js";
import { prepareProviderMessageImages } from "./impl/prepareProviderMessageImages.js";
import { presentToolCall, type PresentedToolCall } from "./impl/presentToolCall.js";
import { replaceLastTurnToolResultImages } from "./impl/replaceLastTurnToolResultImages.js";
import { finalizeCompactionMessage } from "./compaction/finalizeCompactionMessage.js";
import { systemMessageToText } from "./impl/systemMessageToText.js";
import { ABORTED_BY_SIGNAL, raceWithAbort } from "../utils/raceWithAbort.js";
import { createProviderPrompt, type ProviderPrompt } from "./prompt/createSystemPrompt.js";
import { ToolLockManager } from "./impl/ToolLockManager.js";
import { toToolExecutionEndResult } from "./impl/toToolExecutionEndResult.js";
import { errorToMessage } from "../errorToMessage.js";
import type {
    AgentBlock,
    AgentMessage,
    AnyDefinedTool,
    CompactionMessage,
    ContentBlock,
    ErrorMessage,
    Message,
    SteeringMessage,
    SystemMessage,
    ToolResultBlock,
    UserMessage,
} from "./types.js";
import type {
    AssistantContent as ProviderAssistantContent,
    AssistantMessage as ProviderAssistantMessage,
    AssistantMessageEvent,
    Context as ProviderContext,
    Message as ProviderMessage,
    Model,
    Provider,
    ProviderError,
    ProviderAssistantMessageEvent,
    ServiceTier,
    StopReason,
    StreamOptions,
    Tool as ProviderTool,
    ToolCall as ProviderToolCall,
    ToolResultContent as ProviderToolResultContent,
    ToolResultMessage as ProviderToolResultMessage,
    Usage,
    UserContent as ProviderUserContent,
} from "@slopus/rig-execution";
import { toLocalDate } from "../executor/toLocalDate.js";
import {
    AutoPermissionDenialCircuitBreaker,
    describeAutoPermissionDenial,
    reviewAutoPermission,
    type AutoPermissionReview,
    type AutoPermissionRisk,
    type AutoPermissionUserAuthorization,
    type PermissionReviewAgent,
    type PermissionReviewTranscript,
} from "../permissions/index.js";
import type { DebugLog } from "../debug/index.js";
import { resolveModelImageProfile } from "./impl/resolveModelImageProfile.js";
import { toExecutorTool } from "./tools/toExecutorTool.js";
import { isDatabaseFailure } from "../persistence/isDatabaseFailure.js";

export interface RunAgentLoopOptions {
    /** Allows a dedicated permission reviewer to use the provider's hidden reviewer model. */
    allowReviewerModel?: boolean;
    appendSystemPrompt?: string;
    systemPrompt?: string;
    debug?: DebugLog;
    provider: Provider;
    /** Provider whose session is isolated from the coding agent and has no tools. */
    /** Lazily returns the sister agent that reviews Auto permission decisions. */
    permissionReviewAgent?: () => PermissionReviewAgent;
    modelId: string;
    effort?: string;
    serviceTier?: ServiceTier;
    tools: readonly AnyDefinedTool[];
    /** Returns the complete fixed tool array for the next inference iteration. */
    resolveTools?: () => Promise<readonly AnyDefinedTool[]>;
    instructions?: string;
    messages: readonly Message[];
    /** Model-facing history, when the visible transcript has been compacted. */
    contextMessages?: readonly Message[];
    compactContext?: (
        messages: readonly Message[],
        options: {
            createProviderContext: (messages: readonly Message[]) => Promise<ProviderContext>;
            force: boolean;
            reportedTokens?: number;
        },
    ) => Promise<
        | {
              compacted: boolean;
              compactionMessage?: CompactionMessage;
              contextMessages: readonly Message[];
          }
        | undefined
    >;
    signal?: AbortSignal;
    sessionId?: string;
    startDate?: string;
    idFactory?: () => string;
    now?: () => number;
    onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
    onMessage?: (message: Message) => void | Promise<void>;
    /** Checkpoints canonical model context before its durable messages are published. */
    onContextChanged?: (messages: readonly Message[]) => void | Promise<void>;
    takeSteering?: () => readonly SteeringMessage[];
    /** Returns the signal aborted by the next scheduled steering message. */
    getSteeringSignal?: () => AbortSignal;
    context: AgentContext;
}

export type AgentLoopEvent =
    | AssistantMessageEvent
    | {
          type: "context_compaction_started";
          compactionId: string;
          estimatedTokensBefore: number;
          reason: "context_window" | "manual" | "threshold";
      }
    | {
          type: "context_compacted";
          compactionId: string;
          compactedMessageCount: number;
          elapsedMs: number;
          estimatedTokensAfter: number;
          estimatedTokensBefore: number;
          reason: "context_window" | "manual" | "threshold";
      }
    | {
          type: "context_compaction_finished";
          compactionId: string;
          elapsedMs: number;
          status: "cancelled" | "completed" | "failed";
          errorMessage?: string;
      }
    | {
          type: "inference_iteration_start";
          iteration: number;
          messageId: string;
      }
    | {
          type: "steering_applied";
          messageIds: readonly string[];
      }
    | {
          type: "tool_execution_start";
          toolCall: PresentedToolCall;
      }
    | {
          type: "tool_execution_end";
          result: Pick<
              ToolResultBlock,
              | "display"
              | "failure"
              | "isError"
              | "presentation"
              | "toolCallId"
              | "toolName"
              | "type"
          >;
      }
    | {
          type: "tool_execution_progress";
          display: string;
          toolCallId: string;
      }
    | {
          type: "tool_execution_status";
          status: string;
          toolCallId: string;
      }
    | {
          type: "permission_review_started";
          action: string;
          toolCallId: string;
          toolName: string;
      }
    | {
          type: "permission_review";
          action: string;
          decision: "allow" | "deny";
          reason: string;
          risk: AutoPermissionRisk;
          toolCallId: string;
          /** The reviewer's own reasoning, tool calls, and token usage for this verdict. */
          transcript?: PermissionReviewTranscript;
          userAuthorization: AutoPermissionUserAuthorization;
      }
    | {
          action: string;
          reason: string;
          risk: AutoPermissionRisk;
          type: "temporary_full_access_started";
          toolCallId: string;
          userAuthorization: AutoPermissionUserAuthorization;
      }
    | {
          type: "permission_denial_limit_reached";
          reason: string;
      }
    | {
          type: "background_processes_changed";
          processes?: readonly BashSessionActivity[];
          running: number;
      }
    | {
          type: "background_processes_stopped";
          count: number;
      }
    | {
          type: "background_process_exited";
          command: string;
          exitCode: number | null;
          processId: number;
          status: "completed" | "killed";
      };

type PreparedToolPermission =
    | { kind: "skip" }
    | { kind: "error"; result: ToolResultBlock }
    | {
          action: string;
          kind: "review";
          review: AutoPermissionReview;
      };

interface AgentLoopOutcome {
    messages: readonly Message[];
    contextMessages: readonly Message[];
}

/**
 * A failed run always carries the text that explains the failure, so no exit path can
 * report an error the session and the transcript are unable to describe.
 */
export type AgentLoopResult =
    | (AgentLoopOutcome & {
          errorMessage: string;
          providerError: ProviderError;
          providerId: string;
          requestedModelId: string;
          stopReason: "error";
      })
    | (AgentLoopOutcome & { errorMessage?: never; stopReason: Exclude<StopReason, "error"> });

export async function runAgentLoop(
    ctx: RuntimeContext,
    options: RunAgentLoopOptions,
): Promise<AgentLoopResult> {
    const model = findModel(options.provider, options.modelId, options.allowReviewerModel === true);
    const idFactory = options.idFactory ?? createId;
    const now = options.now ?? Date.now;
    const startDate = options.startDate ?? toLocalDate(now());
    const transcript: Message[] = [...options.messages];
    const contextTranscript: Message[] = [
        ...(options.contextMessages ??
            options.messages.filter((message) => !isExcludedFromModelContext(message))),
    ];
    const providerMessages = toProviderMessages(contextTranscript, {
        model,
        now,
        providerId: options.provider.id,
    });
    let providerPrompt = await createProviderPrompt(ctx, {
        ...(options.appendSystemPrompt !== undefined
            ? { appendSystemPrompt: options.appendSystemPrompt }
            : {}),
        ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
        provider: options.provider,
        model,
        ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        messages: contextTranscript,
        context: options.context,
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        tools: options.tools,
    });
    const composedSystemPrompt =
        providerPrompt.systemPromptOverride ?? providerPrompt.systemPrompt ?? "";
    try {
        const replacement = await options.context.plugins?.applySystemPrompt?.(ctx, {
            systemPrompt: composedSystemPrompt,
            userPrompt: latestUserPrompt(contextTranscript),
        });
        if (replacement !== undefined && replacement !== composedSystemPrompt) {
            providerPrompt =
                providerPrompt.systemPromptOverride === undefined
                    ? { ...providerPrompt, systemPrompt: replacement }
                    : { ...providerPrompt, systemPromptOverride: replacement };
        }
    } catch {
        // Plugin prompt middleware is optional and must never fail or stall the agent loop.
    }
    let currentTools = options.tools;
    let providerTools = currentTools.map(toExecutorTool);
    let toolsByName = new Map(
        options.tools.map((tool) => [toolDispatchKey(tool.name, tool.namespace?.name), tool]),
    );
    const toolContext = options.context;
    const toolLocks = new ToolLockManager();
    const compactCurrentContext = (compaction: { force: boolean; reportedTokens?: number }) =>
        compactLoopContext({
            compaction,
            contextTranscript,
            model,
            now,
            options,
            providerMessages,
            providerTools,
            providerPrompt,
            transcript,
        });
    const appendRetriedError = (reason: string) =>
        appendError({
            attempt: 1,
            contextTranscript,
            idFactory,
            now,
            onContextChanged: options.onContextChanged,
            onMessage: options.onMessage,
            outcome: "retried",
            providerId: options.provider.id,
            providerMessages,
            reason,
            requestedModelId: model.id,
            transcript,
        });

    const permissionDenials = new AutoPermissionDenialCircuitBreaker();
    let iteration = 0;
    let contextOverflowRecoveryAttempted = false;
    for (;;) {
        if (options.signal?.aborted) {
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: "aborted",
            };
        }

        if (options.resolveTools !== undefined) {
            currentTools = await options.resolveTools();
            providerTools = currentTools.map(toExecutorTool);
            toolsByName = new Map(
                currentTools.map((tool) => [
                    toolDispatchKey(tool.name, tool.namespace?.name),
                    tool,
                ]),
            );
        }

        iteration += 1;
        const messageId = idFactory();
        await options.onEvent?.({
            type: "inference_iteration_start",
            iteration,
            messageId,
        });

        let assistantMessage: ProviderAssistantMessage;
        let pendingStartEvent: AgentLoopEvent | undefined;
        let deferredErrorEvents: AgentLoopEvent[] = [];
        const rigToolCallIds = new Map<number, string>();
        try {
            const preparedProviderMessages = await prepareProviderMessageImages(
                providerMessages,
                resolveModelImageProfile(model),
            );
            const stream = options.provider.stream(
                ctx,
                model,
                toProviderContext(providerPrompt, preparedProviderMessages, providerTools),
                toStreamOptions(options, startDate),
            );
            const iterator = stream[Symbol.asyncIterator]();
            const consume = async () => {
                for (;;) {
                    const next = await iterator.next();
                    if (next.done) break;
                    if (options.signal?.aborted) {
                        throw new Error("Provider stream was aborted.");
                    }
                    const event = identifyAssistantMessageEvent(
                        assignRigToolCallEventIds(next.value, rigToolCallIds, idFactory),
                        messageId,
                    );
                    if (event.type === "start") {
                        pendingStartEvent = event;
                        continue;
                    }
                    if (event.type === "error") {
                        deferredErrorEvents.push(event);
                        continue;
                    }
                    if (pendingStartEvent !== undefined) {
                        await options.onEvent?.(pendingStartEvent);
                        pendingStartEvent = undefined;
                    }
                    await options.onEvent?.(event);
                    if (event.type === "retrying") {
                        // A retry means a real inference attempt failed. Keep that attempt durable
                        // by design so every backend and UI sees it and the model receives it when
                        // the rebuilt context is replayed, even though the provider keeps running.
                        await appendError({
                            attempt: event.attempt,
                            contextTranscript,
                            idFactory,
                            now,
                            onContextChanged: options.onContextChanged,
                            onMessage: options.onMessage,
                            outcome: "retried",
                            providerId: options.provider.id,
                            providerMessages,
                            reason: event.reason,
                            requestedModelId: model.id,
                            transcript,
                        });
                    }
                }
                return assignRigToolCallIds(await stream.result(), rigToolCallIds, idFactory);
            };
            const outcome = await raceWithAbort(consume(), options.signal);
            if (outcome === ABORTED_BY_SIGNAL) {
                void Promise.resolve(iterator.return?.()).catch(() => undefined);
                await appendSteering(options, transcript, contextTranscript, providerMessages, now);
                return {
                    messages: transcript,
                    contextMessages: contextTranscript,
                    stopReason: "aborted",
                };
            }
            assistantMessage = outcome;
        } catch (error) {
            if (isDatabaseFailure(error)) throw error;
            if (options.signal?.aborted) {
                await appendSteering(options, transcript, contextTranscript, providerMessages, now);
                return {
                    messages: transcript,
                    contextMessages: contextTranscript,
                    stopReason: "aborted",
                };
            }

            if (isInvalidImageRequestError(error)) {
                const replacements = replaceLastTurnToolResultImages(transcript, "Invalid image");
                if (replacements.length > 0) {
                    replaceLastTurnToolResultImages(contextTranscript, "Invalid image");
                    providerMessages.splice(
                        0,
                        providerMessages.length,
                        ...toProviderMessages(contextTranscript, {
                            model,
                            now,
                            providerId: options.provider.id,
                        }),
                    );
                    await options.onContextChanged?.(contextTranscript);
                    for (const replacement of replacements) {
                        await options.onMessage?.(replacement);
                    }
                    await appendRetriedError(errorToMessage(error));
                    continue;
                }
            }

            if (!contextOverflowRecoveryAttempted && isContextWindowExceededError(error)) {
                contextOverflowRecoveryAttempted = true;
                if (await compactCurrentContext({ force: true })) {
                    await appendRetriedError(errorToMessage(error));
                    continue;
                }
            }

            const errorMessage = errorToMessage(error);
            const diagnostics = extractProviderErrorDiagnostics(error, {
                attempts: 1,
                upstreamMessage: errorMessage,
            });
            const providerError: ProviderError = {
                type: "unclassified",
                ...(diagnostics === undefined ? {} : { diagnostics }),
            };
            await appendError({
                contextTranscript,
                idFactory,
                now,
                onContextChanged: options.onContextChanged,
                onMessage: options.onMessage,
                outcome: "failed",
                providerError,
                providerId: options.provider.id,
                providerMessages,
                reason: errorMessage,
                requestedModelId: model.id,
                transcript,
            });
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                errorMessage,
                messages: transcript,
                contextMessages: contextTranscript,
                providerError,
                providerId: options.provider.id,
                requestedModelId: model.id,
                stopReason: "error",
            };
        }

        if (isInvalidImageRequestError(assistantMessage)) {
            const replacements = replaceLastTurnToolResultImages(transcript, "Invalid image");
            if (replacements.length > 0) {
                replaceLastTurnToolResultImages(contextTranscript, "Invalid image");
                providerMessages.splice(
                    0,
                    providerMessages.length,
                    ...toProviderMessages(contextTranscript, {
                        model,
                        now,
                        providerId: options.provider.id,
                    }),
                );
                await options.onContextChanged?.(contextTranscript);
                for (const replacement of replacements) {
                    await options.onMessage?.(replacement);
                }
                await appendRetriedError(
                    assistantMessage.errorMessage ??
                        "The provider rejected an image and the request was retried without it.",
                );
                continue;
            }
        }

        if (
            assistantMessage.stopReason === "error" &&
            !contextOverflowRecoveryAttempted &&
            isContextWindowExceededError(assistantMessage)
        ) {
            contextOverflowRecoveryAttempted = true;
            if (await compactCurrentContext({ force: true })) {
                await appendRetriedError(
                    assistantMessage.errorMessage ??
                        "The model context was too large and was compacted before retrying.",
                );
                continue;
            }
        }

        if (pendingStartEvent !== undefined) {
            await options.onEvent?.(pendingStartEvent);
        }
        for (const event of deferredErrorEvents) {
            await options.onEvent?.(event);
        }

        providerMessages.push(assistantMessage);

        const toolCalls = assistantMessage.content
            .filter(isProviderToolCall)
            .map((toolCall) =>
                normalizeToolCallArguments(toolCall, resolveTool(toolCall, toolsByName)),
            );
        const normalizedToolCalls = new Map(toolCalls.map((toolCall) => [toolCall.id, toolCall]));
        const presentedToolCalls = new Map(
            toolCalls.map((toolCall) => [
                toolCall.id,
                presentToolCall(toolCall, options.tools, toolContext),
            ]),
        );
        const agentMessage = assistantMessageToAgentMessage(
            {
                ...assistantMessage,
                content: assistantMessage.content.map((content) =>
                    content.type === "toolCall"
                        ? (normalizedToolCalls.get(content.id) ?? content)
                        : content,
                ),
            },
            messageId,
            {
                providerId: options.provider.id,
                requestedModelId: model.id,
            },
            (toolCall) => presentedToolCalls.get(toolCall.id),
        );
        const finalizedCompaction = finalizeCompactionMessage(
            contextTranscript,
            transcript,
            assistantMessage.usage,
        );
        if (finalizedCompaction !== undefined) {
            await options.onContextChanged?.(contextTranscript);
            const { usage: _usage, ...notification } = finalizedCompaction;
            await options.onMessage?.(notification);
        }
        if (agentMessage.blocks.length > 0 || assistantMessage.stopReason !== "error") {
            transcript.push(agentMessage);
            contextTranscript.push(agentMessage);
            await options.onContextChanged?.(contextTranscript);
            await options.onMessage?.(agentMessage);
        }

        const incompleteToolCalls = toolCalls.filter((toolCall) => toolCall.incomplete === true);
        if (assistantMessage.stopReason === "length" && incompleteToolCalls.length > 0) {
            await appendNonExecutedToolResults({
                toolCalls: incompleteToolCalls,
                transcript,
                contextTranscript,
                providerMessages,
                idFactory,
                now,
                onEvent: options.onEvent,
                onContextChanged: options.onContextChanged,
                onMessage: options.onMessage,
                message:
                    "The tool call was interrupted because the model reached its output limit.",
            });
        }

        if (assistantMessage.stopReason === "aborted") {
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: assistantMessage.stopReason,
            };
        }

        if (assistantMessage.stopReason === "error") {
            const errorMessage = assistantMessage.errorMessage ?? "The model response failed.";
            const providerError: ProviderError = assistantMessage.providerError ?? {
                type: "unclassified",
                diagnostics: {
                    attempts: 1,
                    upstreamMessage: errorMessage,
                },
            };
            await appendError({
                contextTranscript,
                idFactory,
                now,
                onContextChanged: options.onContextChanged,
                onMessage: options.onMessage,
                outcome: "failed",
                providerError,
                providerId: options.provider.id,
                providerMessages,
                reason: errorMessage,
                requestedModelId: model.id,
                transcript,
            });
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                errorMessage,
                messages: transcript,
                contextMessages: contextTranscript,
                providerError,
                providerId: options.provider.id,
                requestedModelId: model.id,
                stopReason: assistantMessage.stopReason,
            };
        }

        if (assistantMessage.stopReason !== "toolUse") {
            if (assistantMessage.endTurn === false) {
                await compactCurrentContext({
                    force: false,
                    ...(assistantMessage.contextTokens === undefined
                        ? {}
                        : { reportedTokens: assistantMessage.contextTokens }),
                });
                await appendSteering(options, transcript, contextTranscript, providerMessages, now);
                continue;
            }
            if (
                (await appendSteering(
                    options,
                    transcript,
                    contextTranscript,
                    providerMessages,
                    now,
                )) > 0
            ) {
                continue;
            }
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: assistantMessage.stopReason,
            };
        }

        if (toolCalls.length === 0) {
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: assistantMessage.stopReason,
            };
        }

        if (options.signal?.aborted) {
            const interrupted = await appendInterruptedToolResults({
                toolCalls,
                toolsByName,
                transcript,
                contextTranscript,
                providerMessages,
                idFactory,
                now,
                onEvent: options.onEvent,
                onContextChanged: options.onContextChanged,
                onMessage: options.onMessage,
            });
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return interrupted;
        }

        const permissionMessages = transcript.filter(
            (message) => !isExcludedFromModelContext(message),
        );
        const toolMessages = [...contextTranscript];
        const preparedPermissionEntries = await raceWithAbort(
            (async () => {
                const entries: [string, PreparedToolPermission][] = [];
                for (const toolCall of toolCalls) {
                    entries.push([
                        toolCall.id,
                        await prepareToolPermission(ctx, toolCall, toolsByName, toolContext, {
                            messages: permissionMessages,
                            onPermissionReviewStarted: (review) =>
                                options.signal?.aborted
                                    ? Promise.resolve()
                                    : ignoreOptionalFailure(() =>
                                          options.onEvent?.({
                                              type: "permission_review_started",
                                              toolCallId: toolCall.id,
                                              toolName: toolCall.name,
                                              ...review,
                                          }),
                                      ),
                            onPermissionReview: (review) =>
                                options.signal?.aborted
                                    ? Promise.resolve()
                                    : ignoreOptionalFailure(() =>
                                          options.onEvent?.({
                                              type: "permission_review",
                                              toolCallId: toolCall.id,
                                              ...review,
                                          }),
                                      ),
                            ...(options.permissionReviewAgent === undefined
                                ? {}
                                : { permissionReviewAgent: options.permissionReviewAgent }),
                            ...(options.signal === undefined ? {} : { signal: options.signal }),
                        }),
                    ]);
                }
                return entries;
            })(),
            options.signal,
        );
        if (preparedPermissionEntries === ABORTED_BY_SIGNAL) {
            const interrupted = await appendInterruptedToolResults({
                toolCalls,
                toolsByName,
                transcript,
                contextTranscript,
                providerMessages,
                idFactory,
                now,
                onEvent: options.onEvent,
                onContextChanged: options.onContextChanged,
                onMessage: options.onMessage,
            });
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return interrupted;
        }
        const preparedPermissions = new Map(preparedPermissionEntries);
        // Auto never interrupts the user, so a turn that keeps being refused has to stop itself.
        let permissionDenialLimitReached = false;
        for (const [, prepared] of preparedPermissionEntries) {
            if (prepared.kind !== "review") continue;
            if (prepared.review.decision === "allow") {
                permissionDenials.recordAllowed();
                continue;
            }
            permissionDenialLimitReached = permissionDenials.recordDenial()
                ? true
                : permissionDenialLimitReached;
        }
        const executeToolCalls = (calls: readonly ProviderToolCall[]) => {
            type ToolExecutionOutcome = {
                completedBeforeAbort: boolean;
                result: ToolResultBlock;
                toolCall: ProviderToolCall;
            };
            const executionByAction = new Map<string, Promise<ToolExecutionOutcome>>();
            return Promise.all(
                calls.map(async (toolCall) => {
                    const action = sameBatchToolAction(toolCall);
                    const duplicate = executionByAction.get(action);
                    if (duplicate !== undefined) {
                        const outcome = await duplicate;
                        return {
                            ...outcome,
                            result: toolResultForCall(outcome.result, toolCall),
                            toolCall,
                        };
                    }
                    const execution = (async (): Promise<ToolExecutionOutcome> => {
                        const interrupted = () => ({
                            completedBeforeAbort: false,
                            result: interruptedToolResultBlock(toolCall, toolsByName),
                            toolCall,
                        });
                        const operation = (async () => {
                            if (options.signal?.aborted) return interrupted();
                            await ignoreOptionalFailure(() =>
                                options.debug?.record("tool-call", {
                                    iteration,
                                    toolCall,
                                }),
                            );
                            if (options.signal?.aborted) return interrupted();
                            await ignoreOptionalFailure(() =>
                                options.onEvent?.({
                                    type: "tool_execution_start",
                                    toolCall: presentedToolCalls.get(toolCall.id) ?? toolCall,
                                }),
                            );
                            if (options.signal?.aborted) return interrupted();
                            const preparedPermission = preparedPermissions.get(toolCall.id) ?? {
                                kind: "skip" as const,
                            };
                            return toolLocks.run(
                                resolveToolLockKeys(toolCall, toolsByName),
                                async () => {
                                    if (options.signal?.aborted) return interrupted();
                                    const tool = resolveTool(toolCall, toolsByName);
                                    const executionSignal = tool?.steerable
                                        ? combineAbortSignals(
                                              options.signal,
                                              options.getSteeringSignal?.(),
                                          )
                                        : options.signal;
                                    const result = await executeToolCall(
                                        ctx,
                                        toolCall,
                                        toolsByName,
                                        toolContext,
                                        {
                                            batchId: agentMessage.id,
                                            messages: toolMessages,
                                            model,
                                            now,
                                            toolCallIndex: toolCalls.indexOf(toolCall),
                                            onProgress: (display) => {
                                                if (options.signal?.aborted) return;
                                                void ignoreOptionalFailure(() =>
                                                    options.onEvent?.({
                                                        type: "tool_execution_progress",
                                                        display,
                                                        toolCallId: toolCall.id,
                                                    }),
                                                );
                                            },
                                            onStatus: (status) => {
                                                if (options.signal?.aborted) return;
                                                void ignoreOptionalFailure(() =>
                                                    options.onEvent?.({
                                                        type: "tool_execution_status",
                                                        status,
                                                        toolCallId: toolCall.id,
                                                    }),
                                                );
                                            },
                                            onPermissionReview: (review) =>
                                                options.signal?.aborted
                                                    ? Promise.resolve()
                                                    : ignoreOptionalFailure(() =>
                                                          options.onEvent?.({
                                                              type: "permission_review",
                                                              toolCallId: toolCall.id,
                                                              ...review,
                                                          }),
                                                      ),
                                            onTemporaryFullAccessStarted: (review) =>
                                                ignoreOptionalFailure(() =>
                                                    options.onEvent?.({
                                                        type: "temporary_full_access_started",
                                                        toolCallId: toolCall.id,
                                                        ...review,
                                                    }),
                                                ),
                                            onRawResult: (rawResult) =>
                                                options.signal?.aborted
                                                    ? Promise.resolve()
                                                    : ignoreOptionalFailure(() =>
                                                          options.debug?.record("tool-raw-result", {
                                                              iteration,
                                                              rawResult,
                                                              toolCall,
                                                          }),
                                                      ),
                                            onError: (error) =>
                                                ignoreOptionalFailure(() =>
                                                    options.debug?.record("tool-error", {
                                                        error,
                                                        iteration,
                                                        toolCall,
                                                    }),
                                                ),
                                            provider: options.provider,
                                            preparedPermission,
                                            ...(executionSignal === undefined
                                                ? {}
                                                : { signal: executionSignal }),
                                        },
                                    );
                                    return {
                                        completedBeforeAbort: options.signal?.aborted !== true,
                                        result,
                                        toolCall,
                                    };
                                },
                            );
                        })();
                        const raced = await raceWithAbort(operation, options.signal);
                        const outcome = raced === ABORTED_BY_SIGNAL ? interrupted() : raced;
                        const durableResult = outcome.completedBeforeAbort
                            ? outcome.result
                            : interruptedToolResultBlock(toolCall, toolsByName);
                        await ignoreOptionalFailure(() =>
                            options.debug?.record("tool-result", {
                                iteration,
                                result: durableResult,
                                toolCall,
                            }),
                        );
                        await ignoreOptionalFailure(() =>
                            options.onEvent?.({
                                type: "tool_execution_end",
                                result: toToolExecutionEndResult(durableResult),
                            }),
                        );
                        await ignoreOptionalFailure(() =>
                            options.onEvent?.({
                                type: "background_processes_changed",
                                processes: toolContext.bash.activeSessions?.() ?? [],
                                running: toolContext.bash.activeSessionCount?.() ?? 0,
                            }),
                        );
                        return {
                            ...outcome,
                            result: durableResult,
                        };
                    })();
                    executionByAction.set(action, execution);
                    return execution;
                }),
            );
        };
        const immediateCalls = toolCalls.filter(
            (toolCall) => resolveTool(toolCall, toolsByName)?.execution !== "durable",
        );
        const durableCalls = toolCalls.filter(
            (toolCall) => resolveTool(toolCall, toolsByName)?.execution === "durable",
        );

        // Durable calls are an execution barrier. Finish and persist every immediate
        // result first, then publish all durable calls in parallel.
        for (const calls of [immediateCalls, durableCalls]) {
            if (calls.length === 0) continue;
            const outcomes = await executeToolCalls(calls);
            const toolResultBlocks = boundToolResultBlocks(
                outcomes.map((outcome) =>
                    options.signal?.aborted && !outcome.completedBeforeAbort
                        ? interruptedToolResultBlock(outcome.toolCall, toolsByName)
                        : outcome.result,
                ),
            );
            for (const resultBlock of toolResultBlocks) {
                providerMessages.push(toProviderToolResultMessage(resultBlock, now));
            }
            const toolResultMessage: AgentMessage = {
                role: "agent",
                id: idFactory(),
                blocks: toolResultBlocks,
            };
            transcript.push(toolResultMessage);
            contextTranscript.push(toolResultMessage);
            await options.onContextChanged?.(contextTranscript);
            await options.onMessage?.(toolResultMessage);
            for (const resultBlock of toolResultBlocks) {
                const prepared = preparedPermissions.get(resultBlock.toolCallId);
                if (prepared?.kind !== "review" || prepared.review.decision !== "deny") continue;
                if (resultBlock.failure?.kind === "interrupted") continue;
                const denial = createErrorMessage(
                    idFactory(),
                    resultBlock.display,
                    "continued",
                    undefined,
                    "excluded",
                );
                transcript.push(denial);
                await options.onMessage?.(denial);
            }
        }
        if (options.signal?.aborted) {
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: "aborted",
            };
        }
        if (permissionDenialLimitReached) {
            const reason = permissionDenials.describeStop();
            await ignoreOptionalFailure(() =>
                options.onEvent?.({ type: "permission_denial_limit_reached", reason }),
            );
            const stopMessage: AgentMessage = {
                role: "agent",
                id: idFactory(),
                blocks: [{ type: "text", text: reason }],
            };
            transcript.push(stopMessage);
            contextTranscript.push(stopMessage);
            await options.onContextChanged?.(contextTranscript);
            await options.onMessage?.(stopMessage);
            await appendSteering(options, transcript, contextTranscript, providerMessages, now);
            return {
                messages: transcript,
                contextMessages: contextTranscript,
                stopReason: "stop",
            };
        }
        await compactCurrentContext({
            force: false,
            ...(assistantMessage.contextTokens === undefined
                ? {}
                : { reportedTokens: assistantMessage.contextTokens }),
        });
        await appendSteering(options, transcript, contextTranscript, providerMessages, now);
    }
}

async function ignoreOptionalFailure(callback: () => void | Promise<void>): Promise<void> {
    try {
        await callback();
    } catch (error) {
        if (isDatabaseFailure(error)) throw error;
        // Optional telemetry and live observers cannot invalidate durable tool execution.
    }
}

async function compactLoopContext(options: {
    compaction: { force: boolean; reportedTokens?: number };
    contextTranscript: Message[];
    model: Model;
    now: () => number;
    options: RunAgentLoopOptions;
    providerMessages: ProviderMessage[];
    providerTools: readonly ProviderTool[];
    providerPrompt: ProviderPrompt;
    transcript: Message[];
}): Promise<boolean> {
    const result = await options.options.compactContext?.(options.contextTranscript, {
        ...options.compaction,
        createProviderContext: async (messages) => {
            const preparedMessages = await prepareProviderMessageImages(
                toProviderMessages(messages, {
                    model: options.model,
                    now: options.now,
                    providerId: options.options.provider.id,
                }),
                resolveModelImageProfile(options.model),
            );
            return toProviderContext(
                options.providerPrompt,
                preparedMessages,
                options.providerTools,
            );
        },
    });
    if (result?.compacted !== true) return false;
    if (result.compactionMessage === undefined) {
        throw new Error("Compaction completed without a durable compaction message.");
    }

    options.transcript.push(result.compactionMessage);
    options.contextTranscript.splice(
        0,
        options.contextTranscript.length,
        ...result.contextMessages,
    );
    options.providerMessages.splice(
        0,
        options.providerMessages.length,
        ...toProviderMessages(options.contextTranscript, {
            model: options.model,
            now: options.now,
            providerId: options.options.provider.id,
        }),
    );
    await options.options.onContextChanged?.(options.contextTranscript);
    await options.options.onMessage?.(result.compactionMessage);
    return true;
}

async function appendSteering(
    options: RunAgentLoopOptions,
    transcript: Message[],
    contextTranscript: Message[],
    providerMessages: ProviderMessage[],
    now: () => number,
): Promise<number> {
    const steering = options.takeSteering?.() ?? [];
    for (const message of steering) {
        transcript.push(message);
        contextTranscript.push(message);
        providerMessages.push(
            message.role === "system"
                ? toProviderSystemMessage(message, now)
                : toProviderUserMessage(message, now),
        );
    }
    if (steering.length > 0) {
        await options.onContextChanged?.(contextTranscript);
        await options.onEvent?.({
            messageIds: steering.map((message) => message.id),
            type: "steering_applied",
        });
    }
    return steering.length;
}

async function appendError(options: {
    attempt?: number;
    contextTranscript: Message[];
    idFactory: () => string;
    now: () => number;
    onContextChanged: ((messages: readonly Message[]) => void | Promise<void>) | undefined;
    onMessage: ((message: Message) => void | Promise<void>) | undefined;
    outcome: ErrorMessage["outcome"];
    providerError?: ProviderError;
    providerId?: string;
    providerMessages: ProviderMessage[];
    reason: string;
    requestedModelId?: string;
    transcript: Message[];
}): Promise<void> {
    const message = createErrorMessage(
        options.idFactory(),
        options.reason,
        options.outcome,
        options.attempt,
        undefined,
        {
            ...(options.providerError === undefined
                ? {}
                : { providerError: options.providerError }),
            ...(options.providerId === undefined ? {} : { providerId: options.providerId }),
            ...(options.requestedModelId === undefined
                ? {}
                : { requestedModelId: options.requestedModelId }),
        },
    );
    options.transcript.push(message);
    options.contextTranscript.push(message);
    options.providerMessages.push(toProviderErrorMessage(message, options.now));
    await options.onContextChanged?.(options.contextTranscript);
    await options.onMessage?.(message);
}

async function appendInterruptedToolResults(options: {
    toolCalls: readonly ProviderToolCall[];
    toolsByName: ReadonlyMap<string, AnyDefinedTool>;
    transcript: Message[];
    contextTranscript: Message[];
    providerMessages: ProviderMessage[];
    idFactory: () => string;
    now: () => number;
    onEvent: ((event: AgentLoopEvent) => void | Promise<void>) | undefined;
    onContextChanged: ((messages: readonly Message[]) => void | Promise<void>) | undefined;
    onMessage: ((message: Message) => void | Promise<void>) | undefined;
}): Promise<AgentLoopResult> {
    const toolResultBlocks = options.toolCalls.map((toolCall) =>
        interruptedToolResultBlock(toolCall, options.toolsByName),
    );
    for (const resultBlock of toolResultBlocks) {
        await ignoreOptionalFailure(() =>
            options.onEvent?.({
                type: "tool_execution_end",
                result: toToolExecutionEndResult(resultBlock),
            }),
        );
    }
    for (const resultBlock of toolResultBlocks) {
        options.providerMessages.push(toProviderToolResultMessage(resultBlock, options.now));
    }

    const toolResultMessage: AgentMessage = {
        role: "agent",
        id: options.idFactory(),
        blocks: toolResultBlocks,
    };
    options.transcript.push(toolResultMessage);
    options.contextTranscript.push(toolResultMessage);
    await options.onContextChanged?.(options.contextTranscript);
    await options.onMessage?.(toolResultMessage);

    return {
        messages: options.transcript,
        contextMessages: options.contextTranscript,
        stopReason: "aborted",
    };
}

async function appendNonExecutedToolResults(options: {
    toolCalls: readonly ProviderToolCall[];
    transcript: Message[];
    contextTranscript: Message[];
    providerMessages: ProviderMessage[];
    idFactory: () => string;
    now: () => number;
    onEvent: ((event: AgentLoopEvent) => void | Promise<void>) | undefined;
    onContextChanged: ((messages: readonly Message[]) => void | Promise<void>) | undefined;
    onMessage: ((message: Message) => void | Promise<void>) | undefined;
    message: string;
}): Promise<void> {
    const toolResultBlocks = options.toolCalls.map((toolCall) =>
        createErrorToolResultBlock(toolCall, options.message, { kind: "interrupted" }),
    );
    for (const resultBlock of toolResultBlocks) {
        await ignoreOptionalFailure(() =>
            options.onEvent?.({
                type: "tool_execution_end",
                result: toToolExecutionEndResult(resultBlock),
            }),
        );
        options.providerMessages.push(toProviderToolResultMessage(resultBlock, options.now));
    }
    const toolResultMessage: AgentMessage = {
        role: "agent",
        id: options.idFactory(),
        blocks: toolResultBlocks,
    };
    options.transcript.push(toolResultMessage);
    options.contextTranscript.push(toolResultMessage);
    await options.onContextChanged?.(options.contextTranscript);
    await options.onMessage?.(toolResultMessage);
}

function findModel(provider: Provider, modelId: string, allowReviewerModel: boolean): Model {
    const model =
        provider.models.find((candidate) => candidate.id === modelId) ??
        (allowReviewerModel && provider.reviewerModel?.id === modelId
            ? provider.reviewerModel
            : undefined);
    if (!model) {
        throw new Error(`Unknown model '${modelId}' for provider '${provider.id}'`);
    }

    return model;
}

function toStreamOptions(options: RunAgentLoopOptions, startDate: string): StreamOptions {
    return {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
        startDate,
        ...(options.effort !== undefined ? { thinking: options.effort } : {}),
    };
}

function toProviderContext(
    providerPrompt: ProviderPrompt,
    messages: readonly ProviderMessage[],
    tools: readonly ProviderTool[],
): ProviderContext {
    return {
        ...providerPrompt,
        messages: [...messages],
        ...(tools.length > 0 ? { tools: [...tools] } : {}),
    };
}

export function toProviderMessages(
    messages: readonly Message[],
    options: {
        model: Model;
        now: () => number;
        providerId: string;
    },
): ProviderMessage[] {
    const providerMessages: ProviderMessage[] = [];

    for (const message of messages) {
        if (isExcludedFromModelContext(message)) continue;
        if (message.role === "system") {
            // A notice belongs in the conversation at the position it was raised. Each provider
            // resolves it into its own native shape, so it never becomes prompt content here.
            providerMessages.push({
                role: "system",
                content: systemMessageToText(message),
                sourceMessageId: message.id,
                timestamp: options.now(),
            });
            continue;
        }

        if (message.role === "user") {
            providerMessages.push(toProviderUserMessage(message, options.now));
            continue;
        }

        if (message.role === "compaction") {
            if (message.replacementMessages === undefined) {
                throw new Error("Compaction context is missing its provider replacement messages.");
            }
            providerMessages.push(...message.replacementMessages);
            continue;
        }

        if (message.role === "error") {
            providerMessages.push(toProviderErrorMessage(message, options.now));
            continue;
        }

        providerMessages.push(...toProviderMessagesFromAgentMessage(message, options));
    }

    return providerMessages;
}

function toProviderErrorMessage(message: ErrorMessage, now: () => number): ProviderMessage {
    // Durable inference failures are model-visible by design, including attempts whose provider
    // recovered internally. The next model-facing inference after recovery should retain why Rig
    // had to reconnect or replay.
    const attempt = message.attempt === undefined ? "" : ` attempt ${String(message.attempt)}`;
    const heading =
        message.outcome === "retried"
            ? `Rig inference${attempt} failed and was retried.`
            : message.outcome === "continued"
              ? "Rig encountered an error and continued."
              : "Rig's previous work stopped with an error.";
    return {
        content: [{ text: heading, type: "text" }, ...message.blocks.map(toProviderUserContent)],
        role: "user",
        sourceMessageId: message.id,
        timestamp: now(),
    };
}

function toProviderSystemMessage(message: SystemMessage, now: () => number): ProviderMessage {
    return {
        role: "system",
        content: systemMessageToText(message),
        sourceMessageId: message.id,
        timestamp: now(),
    };
}

function toProviderUserMessage(message: UserMessage, now: () => number): ProviderMessage {
    const backgroundContextHeading =
        "Background context only. This is not a request. Use it when answering the next actionable message.";
    return {
        role: "user",
        content:
            message.contextOnly === true
                ? [
                      { type: "text", text: backgroundContextHeading } as const,
                      ...message.blocks.map(toProviderUserContent),
                  ]
                : message.blocks.map(toProviderUserContent),
        ...(message.contextOnly === true ? { contextOnly: true as const } : {}),
        sourceMessageId: message.id,
        ...(message.encryptedAgentMessage === undefined
            ? {}
            : { encryptedAgentMessage: message.encryptedAgentMessage }),
        ...(message.agentMessageTriggerTurn === undefined
            ? {}
            : { agentMessageTriggerTurn: message.agentMessageTriggerTurn }),
        timestamp: now(),
    };
}

function toProviderMessagesFromAgentMessage(
    message: AgentMessage,
    options: {
        model: Model;
        now: () => number;
        providerId: string;
    },
): ProviderMessage[] {
    const assistantContent: ProviderAssistantContent[] = [];
    const toolResultBlocks: ToolResultBlock[] = [];

    for (const block of message.blocks) {
        if (block.type === "tool_result") {
            toolResultBlocks.push(block);
            continue;
        }

        assistantContent.push(toProviderAssistantContent(block));
    }

    const stopReason: StopReason = assistantContent.some(isProviderToolCall) ? "toolUse" : "stop";

    return [
        ...(assistantContent.length > 0
            ? [
                  {
                      role: "assistant" as const,
                      content: assistantContent,
                      api: "rig",
                      provider: options.providerId,
                      model: options.model.id,
                      usage: zeroUsage(),
                      stopReason,
                      timestamp: options.now(),
                      ...(message.sessionMessage === undefined
                          ? {}
                          : { sessionMessage: message.sessionMessage }),
                  },
              ]
            : []),
        ...boundToolResultBlocks(toolResultBlocks).map((block) =>
            toProviderToolResultMessage(block, options.now),
        ),
    ];
}

function toProviderUserContent(block: ContentBlock): ProviderUserContent {
    if (block.type === "text") {
        return {
            type: "text",
            text: block.text,
        };
    }

    return {
        type: "image",
        data: block.data,
        mimeType: block.mediaType,
        ...(block.detail !== undefined ? { detail: block.detail } : {}),
    };
}

function latestUserPrompt(messages: readonly Message[]): string {
    const message = messages.findLast((candidate): candidate is UserMessage => {
        return candidate.role === "user";
    });
    if (message === undefined) return "";
    return message.blocks
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
}

function toProviderToolResultContent(block: ContentBlock): ProviderToolResultContent {
    return toProviderUserContent(block);
}

function toProviderAssistantContent(
    block: Exclude<AgentBlock, ToolResultBlock>,
): ProviderAssistantContent {
    if (block.type === "text") {
        return {
            type: "text",
            text: block.text,
        };
    }

    if (block.type === "thinking") {
        return {
            type: "thinking",
            thinking: block.thinking,
            ...(block.encrypted !== undefined ? { encrypted: block.encrypted } : {}),
            ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
        };
    }

    if (block.type === "tool_call") {
        return {
            type: "toolCall",
            id: block.id,
            ...(block.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: block.providerToolCallId }),
            name: block.name,
            ...(block.namespace === undefined ? {} : { namespace: block.namespace }),
            arguments: block.arguments as Record<string, unknown>,
            ...(block.incomplete === true ? { incomplete: true } : {}),
            ...(block.kind === undefined ? {} : { kind: block.kind }),
            ...(block.vendor === undefined ? {} : { vendor: block.vendor }),
        };
    }

    throw new Error("Assistant image blocks are not supported by providers");
}

function resolveToolLockKeys(
    toolCall: ProviderToolCall,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
): readonly string[] {
    const tool = resolveTool(toolCall, toolsByName);
    if (tool === undefined || !Value.Check(tool.arguments, toolCall.arguments)) return [];
    return tool.locks.map((lock) =>
        typeof lock === "string" ? lock : lock(toolCall.arguments as never),
    );
}

function toProviderToolResultMessage(
    block: ToolResultBlock,
    now: () => number,
): ProviderToolResultMessage {
    return {
        role: "toolResult",
        toolCallId: block.toolCallId,
        ...(block.providerToolCallId === undefined
            ? {}
            : { providerToolCallId: block.providerToolCallId }),
        toolName: block.toolName,
        content: block.rendered.map(toProviderToolResultContent),
        isError: block.isError ?? false,
        timestamp: now(),
        ...(block.vendor === undefined ? {} : { vendor: block.vendor }),
    };
}

async function prepareToolPermission(
    ctx: RuntimeContext,
    toolCall: ProviderToolCall,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
    context: AgentContext,
    options: {
        messages: readonly Message[];
        onPermissionReview?: (review: {
            action: string;
            decision: "allow" | "deny";
            reason: string;
            risk: AutoPermissionRisk;
            transcript?: PermissionReviewTranscript;
            userAuthorization: AutoPermissionUserAuthorization;
        }) => void | Promise<void>;
        onPermissionReviewStarted?: (review: { action: string }) => void | Promise<void>;
        permissionReviewAgent?: () => PermissionReviewAgent;
        signal?: AbortSignal;
    },
): Promise<PreparedToolPermission> {
    const tool = resolveTool(toolCall, toolsByName);
    if (
        tool === undefined ||
        !Value.Check(tool.arguments, toolCall.arguments) ||
        context.permissions?.mode !== "auto"
    ) {
        return { kind: "skip" };
    }
    try {
        if (!(await tool.shouldReviewInAutoMode(toolCall.arguments as never, context))) {
            return { kind: "skip" };
        }
        if (tool.describeAutoPermissionAction === undefined) {
            return {
                kind: "error",
                result: createErrorToolResultBlock(
                    toolCall,
                    "This tool cannot request Auto approval because its permission action is not defined.",
                ),
            };
        }
        const action = tool.describeAutoPermissionAction(toolCall.arguments as never, context);
        await options.onPermissionReviewStarted?.({ action });
        const reviewAgent = options.permissionReviewAgent;
        if (reviewAgent === undefined) {
            // Auto without a reviewer must fall back to the user, never to silent execution.
            const review = {
                decision: "deny",
                denialKind: "unavailable",
                reason: "No automatic permission reviewer is available for this session.",
                risk: "medium",
                userAuthorization: "low",
            } as const;
            await options.onPermissionReview?.({ action, ...review });
            return { action, kind: "review", review };
        }
        const review = await reviewAutoPermission(ctx, {
            action,
            args: toolCall.arguments,
            messages: options.messages,
            reviewer: reviewAgent(),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            toolName: tool.name,
        });
        await options.onPermissionReview?.({
            action,
            decision: review.decision,
            reason: review.reason,
            risk: review.risk,
            ...(review.transcript === undefined ? {} : { transcript: review.transcript }),
            userAuthorization: review.userAuthorization,
        });
        return { action, kind: "review", review };
    } catch (error) {
        if (isDatabaseFailure(error)) throw error;
        const message = errorToMessage(error);
        return {
            kind: "error",
            result: createErrorToolResultBlock(toolCall, `Tool '${tool.name}' failed: ${message}`, {
                kind: "execution_failed",
                message,
            }),
        };
    }
}

async function executeToolCall(
    ctx: RuntimeContext,
    toolCall: ProviderToolCall,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
    context: AgentContext,
    options: {
        batchId: string;
        messages: readonly Message[];
        model: Model;
        now: () => number;
        onProgress?: (display: string) => void;
        onStatus?: (status: string) => void;
        onPermissionReview?: (review: {
            action: string;
            decision: "allow" | "deny";
            reason: string;
            risk: AutoPermissionRisk;
            transcript?: PermissionReviewTranscript;
            userAuthorization: AutoPermissionUserAuthorization;
        }) => void | Promise<void>;
        onTemporaryFullAccessStarted?: (review: {
            action: string;
            reason: string;
            risk: AutoPermissionRisk;
            userAuthorization: AutoPermissionUserAuthorization;
        }) => void | Promise<void>;
        onError?: (error: unknown) => void | Promise<void>;
        onRawResult?: (result: unknown) => void | Promise<void>;
        preparedPermission: PreparedToolPermission;
        provider: Provider;
        signal?: AbortSignal;
        toolCallIndex: number;
    },
): Promise<ToolResultBlock> {
    const tool = resolveTool(toolCall, toolsByName);
    if (!tool) {
        return createErrorToolResultBlock(
            toolCall,
            `Unknown tool '${toolCall.name}' requested by model`,
            { kind: "tool_unavailable" },
        );
    }

    if (!Value.Check(tool.arguments, toolCall.arguments)) {
        const message = formatInvalidToolArguments(tool.name, tool.arguments, toolCall.arguments);
        return createErrorToolResultBlock(toolCall, message, {
            kind: "invalid_arguments",
            message,
        });
    }

    if (context.permissions === undefined) {
        return createErrorToolResultBlock(
            toolCall,
            "This action requires an available permission context.",
        );
    }

    if (
        tool.requiresAutoOrFullAccess &&
        context.permissions.mode !== "auto" &&
        context.permissions.mode !== "full_access"
    ) {
        return createErrorToolResultBlock(
            toolCall,
            "This action requires Auto or Full access because it can operate outside Rig's local sandbox.",
        );
    }

    try {
        if (options.preparedPermission.kind === "error") {
            return options.preparedPermission.result;
        }
        let runWithFullAccess = false;
        if (options.preparedPermission.kind === "review") {
            const { review } = options.preparedPermission;
            if (review.decision === "deny") {
                return createErrorToolResultBlock(
                    toolCall,
                    describeAutoPermissionDenial(options.preparedPermission.action, review),
                );
            }
            runWithFullAccess = await tool.shouldRunInFullAccessInAutoMode(
                toolCall.arguments as never,
                context,
            );
        }

        const execute = tool.execute as (
            args: unknown,
            context: AgentContext,
            options: {
                ctx: RuntimeContext;
                messages?: readonly Message[];
                model?: Model;
                onProgress?: (display: string) => void;
                onStatus?: (status: string) => void;
                provider?: Provider;
                providerToolCallId?: string;
                signal?: AbortSignal;
                toolBatchId?: string;
                toolCallId?: string;
                toolCallIndex?: number;
            },
        ) => Promise<unknown> | unknown;
        const executionOptions: {
            ctx: RuntimeContext;
            messages?: readonly Message[];
            model?: Model;
            onProgress?: (display: string) => void;
            onStatus?: (status: string) => void;
            provider?: Provider;
            providerToolCallId?: string;
            signal?: AbortSignal;
            toolBatchId?: string;
            toolCallId?: string;
            toolCallIndex?: number;
        } = {
            ctx,
            messages: options.messages,
            model: options.model,
            provider: options.provider,
            ...(toolCall.providerToolCallId === undefined
                ? {}
                : { providerToolCallId: toolCall.providerToolCallId }),
            toolCallId: toolCall.id,
        };
        if (tool.execution === "durable") {
            executionOptions.toolBatchId = options.batchId;
            executionOptions.toolCallIndex = options.toolCallIndex;
        }
        if (options.onProgress !== undefined) executionOptions.onProgress = options.onProgress;
        if (options.onStatus !== undefined) executionOptions.onStatus = options.onStatus;
        if (options.signal !== undefined) executionOptions.signal = options.signal;
        const run = () => execute(toolCall.arguments, context, executionOptions);
        if (runWithFullAccess && context.permissions?.mode !== "auto") {
            if (context.permissions?.mode !== "full_access") {
                return createErrorToolResultBlock(
                    toolCall,
                    `Tool '${tool.name}' was not run because the permission mode changed before its Auto-approved full-access execution began.`,
                    { kind: "interrupted" },
                );
            }
            runWithFullAccess = false;
        }
        let result: unknown;
        if (runWithFullAccess && context.permissions !== undefined) {
            if (options.preparedPermission.kind !== "review") {
                throw new Error(
                    `Tool '${tool.name}' cannot start temporary Full access without an Auto review.`,
                );
            }
            const { action, review } = options.preparedPermission;
            // runWithMode invokes the action synchronously, so there is no await between the fresh
            // boundary check above and starting the exact call under its temporary override.
            const execution = context.permissions.runWithMode("full_access", run).then(
                (value) => ({ status: "fulfilled", value }) as const,
                (reason: unknown) => ({ status: "rejected", reason }) as const,
            );
            await options.onTemporaryFullAccessStarted?.({
                action,
                reason: review.reason,
                risk: review.risk,
                userAuthorization: review.userAuthorization,
            });
            const settled = await execution;
            if (settled.status === "rejected") throw settled.reason;
            result = settled.value;
        } else {
            result = await run();
        }
        options.signal?.throwIfAborted();
        await options.onRawResult?.(result);
        return createToolResultBlock(
            tool,
            toolCall.arguments,
            result,
            toolCall.id,
            toolCall.vendor,
            toolCall.providerToolCallId,
        );
    } catch (error) {
        if (isDatabaseFailure(error)) throw error;
        await options.onError?.(error);
        if (options.signal?.aborted) {
            return createErrorToolResultBlock(
                toolCall,
                tool.interruptionMessage ?? "Interrupted by user.",
                { kind: "interrupted" },
            );
        }
        const message = errorToMessage(error);
        return createErrorToolResultBlock(toolCall, `Tool '${tool.name}' failed: ${message}`, {
            kind: "execution_failed",
            message,
        });
    }
}

/** One externally visible action, independent of provider-generated call ids. */
function sameBatchToolAction(toolCall: ProviderToolCall): string {
    try {
        return canonicalJson([
            toolCall.name,
            toolCall.namespace ?? null,
            toolCall.kind ?? null,
            toolCall.arguments,
        ]);
    } catch {
        // Provider tool arguments are JSON in normal operation. If a custom
        // provider violates that contract, keep the calls distinct rather than
        // guessing that two opaque values describe the same action.
        return toolCall.id;
    }
}

function canonicalJson(value: unknown): string {
    const serialized = JSON.stringify(value, (_key, entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
        return Object.fromEntries(
            Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
                left < right ? -1 : left > right ? 1 : 0,
            ),
        );
    });
    if (serialized === undefined) throw new Error("Tool arguments are not JSON.");
    return serialized;
}

/** Reuses one execution result while answering every provider call it represents. */
function toolResultForCall(result: ToolResultBlock, toolCall: ProviderToolCall): ToolResultBlock {
    const { providerToolCallId: _providerToolCallId, ...shared } = result;
    return {
        ...shared,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ...(toolCall.providerToolCallId === undefined
            ? {}
            : { providerToolCallId: toolCall.providerToolCallId }),
    };
}

function combineAbortSignals(
    first: AbortSignal | undefined,
    second: AbortSignal | undefined,
): AbortSignal | undefined {
    if (first === undefined) return second;
    if (second === undefined || first === second) return first;
    return AbortSignal.any([first, second]);
}

function interruptedToolResultBlock(
    toolCall: ProviderToolCall,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
): ToolResultBlock {
    const message =
        resolveTool(toolCall, toolsByName)?.interruptionMessage ?? "Interrupted by user.";
    return createErrorToolResultBlock(toolCall, message, { kind: "interrupted" });
}

function resolveTool(
    toolCall: Pick<ProviderToolCall, "name" | "namespace">,
    toolsByName: ReadonlyMap<string, AnyDefinedTool>,
): AnyDefinedTool | undefined {
    return toolsByName.get(toolDispatchKey(toolCall.name, toolCall.namespace));
}

function toolDispatchKey(name: string, namespace: string | undefined): string {
    return `${namespace ?? ""}\u0000${name}`;
}

function isProviderToolCall(content: ProviderAssistantContent): content is ProviderToolCall {
    return content.type === "toolCall";
}

function assignRigToolCallIds(
    message: ProviderAssistantMessage,
    rigToolCallIds: Map<number, string>,
    idFactory: () => string,
): ProviderAssistantMessage {
    return {
        ...message,
        content: message.content.map((content, contentIndex) =>
            content.type === "toolCall"
                ? localizeToolCall(content, contentIndex, rigToolCallIds, idFactory)
                : content,
        ),
    };
}

function assignRigToolCallEventIds(
    event: ProviderAssistantMessageEvent,
    rigToolCallIds: Map<number, string>,
    idFactory: () => string,
): ProviderAssistantMessageEvent {
    if (event.type === "done") {
        return {
            ...event,
            message: assignRigToolCallIds(event.message, rigToolCallIds, idFactory),
        };
    }
    if (event.type === "error") {
        return {
            ...event,
            error: assignRigToolCallIds(event.error, rigToolCallIds, idFactory),
        };
    }
    if (!("partial" in event)) return event;
    const partial = assignRigToolCallIds(event.partial, rigToolCallIds, idFactory);
    if (event.type !== "toolcall_end") return { ...event, partial };
    const toolCall = partial.content[event.contentIndex];
    return toolCall?.type === "toolCall" ? { ...event, partial, toolCall } : { ...event, partial };
}

function identifyAssistantMessageEvent(
    event: ProviderAssistantMessageEvent,
    messageId: string,
): AssistantMessageEvent {
    return { ...event, messageId };
}

function localizeToolCall(
    toolCall: ProviderToolCall,
    contentIndex: number,
    rigToolCallIds: Map<number, string>,
    idFactory: () => string,
): ProviderToolCall {
    let rigId = rigToolCallIds.get(contentIndex);
    if (rigId === undefined) {
        rigId = idFactory();
        rigToolCallIds.set(contentIndex, rigId);
    }
    return {
        ...toolCall,
        id: rigId,
        providerToolCallId: toolCall.providerToolCallId ?? toolCall.id,
    };
}

function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    };
}
