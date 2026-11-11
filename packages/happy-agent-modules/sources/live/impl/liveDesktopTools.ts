import { defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { liveDesktopActionSchema, type LiveDesktopAction } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";
import type { LiveModule } from "../LiveModule.js";

const resultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });

/**
 * One desktop action as Voice's tool. Desktop actions are what the person does by clicking, and
 * the desktop verifies each one, so they need no review; they are never durable, because an
 * interrupted action may already have happened and is never executed again.
 */
const tool = (
    live: LiveModule,
    agentId: string,
    name: LiveDesktopAction["type"],
    description: string,
    capability: string,
    index: number,
): AnyAgentTool =>
    defineAgentTool({
        name,
        defer: false,
        description,
        capabilities: [capability],
        parameters: Type.Omit(liveDesktopActionSchema.anyOf[index]!, ["type"]),
        returnType: resultSchema,
        durable: false,
        shouldReviewInAutoMode: () => false,
        autoReview: "never",
        execute: async (ctx, args) => ({
            text: await live.runVoiceAction(ctx, agentId, {
                ...(args as object),
                type: name,
            } as LiveDesktopAction),
        }),
        toLLM: (result) => [{ type: "text", text: result.text }],
    });

/** The fixed desktop surface every call offers; arrays are merged, never assembled by name. */
export function liveDesktopTools(live: LiveModule, agentId: string): AnyAgentTool[] {
    return [
        tool(
            live,
            agentId,
            "desktopState",
            "Read the call's desktop window: its visible context, targets, and each server's sidebar and model choices.",
            "Read the voice call's desktop window.",
            0,
        ),
        tool(
            live,
            agentId,
            "desktopOpen",
            "Open an explicitly identified desktop target. Use it alone only when the request is just to open or show something; sessionSend and composerDraftAppend open their own conversation.",
            "Open a conversation, project, or workspace in the call's window.",
            1,
        ),
        tool(
            live,
            agentId,
            "sessionRead",
            "Read bounded public messages and structured status of a conversation in the call's window.",
            "Read a conversation's public messages in the call's window.",
            5,
        ),
        tool(
            live,
            agentId,
            "sessionSend",
            "Stage exact text in the named conversation for independent human review and Send, opening that conversation first when it is not focused. This does NOT send it or answer questions.",
            "Stage a message in a conversation for the person to send.",
            6,
        ),
        tool(
            live,
            agentId,
            "composerDraftAppend",
            "Append text to the named conversation's draft without replacing draft text or attachments, opening that conversation first when it is not focused.",
            "Add text to a conversation's draft.",
            8,
        ),
    ];
}

/** Offered when the call's desktop negotiated the `taskCreate` capability. */
export function liveTaskCreateTools(live: LiveModule, agentId: string): AnyAgentTool[] {
    return [
        tool(
            live,
            agentId,
            "taskCreate",
            "Create a task on a server and open it. Its text becomes the task's unsent opening draft for the person to review and Send; an optional model must be one of that server's listed models.",
            "Create a task with an unsent opening draft.",
            9,
        ),
    ];
}

/** Offered when the call's desktop negotiated the `sessionModelChange` capability. */
export function liveModelChangeTools(live: LiveModule, agentId: string): AnyAgentTool[] {
    return [
        tool(
            live,
            agentId,
            "sessionModelChange",
            "Choose the model a conversation's next message uses, from its server's listed models. Keeps the draft and never interrupts a running turn.",
            "Choose the model of a conversation's next message.",
            10,
        ),
    ];
}
