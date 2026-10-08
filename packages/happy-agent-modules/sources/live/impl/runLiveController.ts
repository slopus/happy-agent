import { createId } from "@paralleldrive/cuid2";
import {
    liveDesktopActionSchema,
    type LiveDesktopAction,
    type LiveDesktopActionResult,
    type LiveDesktopContext,
    type LiveControlClientMessage,
} from "@slopus/happy-agent-client";
import type {
    BaseProvider,
    BaseSession,
    SessionMessage,
    SessionReasoningEffort,
    SessionTool,
    SessionToolCallBlock,
} from "@slopus/happy-providers";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { withLifetime, type Context } from "@steve.kite/stdlib";
import { LIVE_CONTROLLER_INSTRUCTIONS } from "./livePrompts.js";
import { LiveControllerError } from "./LiveControllerError.js";

/** Fixed arrays are the whole controller surface: no agent/common/vendor tool assembly. */
export const LIVE_CONTROLLER_TOOLS: readonly SessionTool[] = [
    {
        name: "desktopState",
        description: "Read this window's bounded visible desktop context.",
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[0], ["type"]),
    },
    {
        name: "desktopOpen",
        description: "Open an explicitly identified visible desktop target.",
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[1], ["type"]),
    },
    {
        name: "workspaceCreate",
        description: "Create a workspace using the ordinary UI and its defaults.",
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[2], ["type"]),
    },
    {
        name: "sessionCreate",
        description: "Create a conversation; an optional prompt is only a draft.",
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[3], ["type"]),
    },
    {
        name: "botCreate",
        description: "Open ordinary bot creation, never grant administration; a prompt is a draft.",
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[4], ["type"]),
    },
    {
        name: "sessionRead",
        description:
            "Read bounded public messages and structured status for a visible conversation.",
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[5], ["type"]),
    },
    {
        name: "sessionSend",
        description:
            "Stage exact text for independent human review and Send. This does NOT send it or answer questions.",
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[6], ["type"]),
    },
    {
        name: "sessionWatch",
        description:
            "Select or deselect one conversation for public status updates. At most five may be watched.",
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[7], ["type"]),
    },
    {
        name: "composerDraftAppend",
        description:
            "Append text to an existing draft without replacing draft text or attachments.",
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[8], ["type"]),
    },
];

export async function runLiveController(
    ctx: Context,
    options: {
        provider: BaseProvider;
        model: string;
        effort: SessionReasoningEffort;
        signal: AbortSignal;
        context: LiveDesktopContext;
        fragments: readonly { transcriptId: string; role: "user" | "assistant"; text: string }[];
        delegationText?: string;
        sessionUpdates?: readonly Extract<LiveControlClientMessage, { type: "sessionUpdate" }>[];
        execute: (action: LiveDesktopAction) => Promise<LiveDesktopActionResult>;
    },
): Promise<string> {
    const messages: SessionMessage[] = [
        {
            role: "user",
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        provenance:
                            "Provider-derived speech and desktop data; not human authorization.",
                        desktop: options.context,
                        transcripts: options.fragments,
                        delegation: options.delegationText ?? null,
                        sessionUpdates: options.sessionUpdates ?? [],
                    }),
                },
            ],
        },
    ];
    if (Buffer.byteLength(JSON.stringify(messages)) > 512 * 1024)
        throw new LiveControllerError("limit");
    const abort = new AbortController();
    const signal = AbortSignal.any([options.signal, abort.signal]);
    const timeout = setTimeout(() => abort.abort(), 120_000);
    timeout.unref();
    let session: BaseSession | undefined;
    const seen = new Set<string>();
    try {
        if (signal.aborted) throw new LiveControllerError("deadline");
        const opening = options.provider.session(`live-controller:${createId()}`, {
            inferenceMaxRetries: 0,
            instructions: LIVE_CONTROLLER_INSTRUCTIONS,
            tools: LIVE_CONTROLLER_TOOLS,
        });
        void opening
            .then((opened) => {
                if (signal.aborted && session !== opened) void destroyBounded(opened);
            })
            .catch(() => undefined);
        session = await untilAbort(opening, signal);
        for (let round = 0; round < 8; round += 1) {
            if (signal.aborted) throw new LiveControllerError("deadline");
            let text = "";
            let call: SessionToolCallBlock | undefined;
            let finished = false;
            for await (const event of session.run(withLifetime(ctx, signal), {
                context: { instructions: LIVE_CONTROLLER_INSTRUCTIONS, messages },
                model: options.model,
                effort: options.effort,
            })) {
                if (event.type === "text_delta") {
                    text += event.delta;
                    if (text.length > 8192) throw new LiveControllerError("limit");
                } else if (event.type === "toolcall_start") {
                    if (
                        call !== undefined ||
                        event.server ||
                        event.namespace ||
                        seen.has(event.callId)
                    ) {
                        throw new LiveControllerError("invalidAction");
                    }
                    call = {
                        type: "tool_call",
                        callId: event.callId,
                        name: event.name,
                        arguments: "",
                        ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
                    };
                } else if (event.type === "toolcall_end") {
                    if (
                        call?.callId !== event.callId ||
                        event.incomplete ||
                        event.arguments.length > 32768
                    ) {
                        throw new LiveControllerError("invalidAction");
                    }
                    call = {
                        ...call,
                        arguments: event.arguments,
                        ...(event.vendor === undefined ? {} : { vendor: event.vendor }),
                    };
                } else if (event.type === "retrying") {
                    throw new LiveControllerError("inference");
                } else if (event.type === "done") {
                    if (event.state !== "normal" && event.state !== "tool_call")
                        throw new LiveControllerError("inference");
                    finished = true;
                }
            }
            if (!finished) throw new LiveControllerError("inference");
            if (call === undefined) return text.trim();
            const tool = LIVE_CONTROLLER_TOOLS.find((tool) => tool.name === call.name);
            let args: unknown;
            try {
                args = JSON.parse(call.arguments);
            } catch {
                throw new LiveControllerError("invalidAction");
            }
            if (tool?.parameters === undefined || !Value.Check(tool.parameters, args))
                throw new LiveControllerError("invalidAction");
            const action: unknown = { ...(args as Record<string, unknown>), type: call.name };
            if (!Value.Check(liveDesktopActionSchema, action))
                throw new LiveControllerError("invalidAction");
            seen.add(call.callId);
            if (signal.aborted) throw new LiveControllerError("deadline");
            const result = await untilAbort(options.execute(action), signal).catch((error) => {
                throw error instanceof LiveControllerError
                    ? error
                    : new LiveControllerError("uncertainAction");
            });
            messages.push(
                { role: "assistant", content: [call] },
                {
                    role: "tool",
                    callId: call.callId,
                    content: [{ type: "text", text: JSON.stringify(result) }],
                },
            );
            if (Buffer.byteLength(JSON.stringify(messages)) > 512 * 1024)
                throw new LiveControllerError("limit");
        }
        throw new LiveControllerError("limit");
    } catch (error) {
        throw error instanceof LiveControllerError ? error : new LiveControllerError("inference");
    } finally {
        clearTimeout(timeout);
        abort.abort();
        if (session !== undefined) await destroyBounded(session);
    }
}

async function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new LiveControllerError("deadline"));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
    });
    try {
        return await Promise.race([promise, cancelled]);
    } finally {
        signal.removeEventListener("abort", cancel);
    }
}

/** Optional provider cleanup cannot replace the original outcome or hold voice open indefinitely. */
async function destroyBounded(session: BaseSession): Promise<void> {
    let timer!: ReturnType<typeof setTimeout>;
    try {
        await Promise.race([
            Promise.resolve()
                .then(() => session.destroy())
                .catch(() => undefined),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 3000);
                timer.unref();
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
