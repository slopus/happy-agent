import type {
    HappyAgentClient,
    QuickReply,
    SendMessageResponse,
    UiActionRequest,
    UiDocument,
} from "@slopus/happy-agent-client";
import type { AgentGym, GymInferenceRequest, GymTurn } from "@slopus/happy-agent-gym";

/** One block of a public message, as far as chat UI scenarios read it. */
export interface ChatUiBlock {
    readonly type: string;
    readonly text?: string;
    readonly ui?: UiDocument;
    readonly options?: readonly string[];
    readonly presentation?: {
        readonly type: string;
        readonly ui?: UiDocument;
        readonly options?: readonly string[];
        readonly items?: readonly Record<string, unknown>[];
    };
    readonly [key: string]: unknown;
}

/** One public message, with the run that holds it. */
export interface ChatUiMessage {
    readonly id: string;
    readonly runId: string;
    readonly runStatus: string;
    readonly role: string;
    readonly content: readonly ChatUiBlock[];
    readonly quickReply?: QuickReply;
}

/** The conversation's messages, oldest first, as a client that reads chat UI sees them. */
export async function messagesOf(
    gym: AgentGym,
    agentId: string,
    client: HappyAgentClient = gym.client,
): Promise<ChatUiMessage[]> {
    const page = (await client.getMessages(agentId)) as unknown as {
        runs: {
            id: string;
            status: string;
            messages: Omit<ChatUiMessage, "runId" | "runStatus">[];
        }[];
    };
    return page.runs.flatMap((run) =>
        run.messages.map((message) => ({ ...message, runId: run.id, runStatus: run.status })),
    );
}

export function textOf(message: ChatUiMessage | undefined): string {
    return message?.content.map((block) => block.text ?? "").join("") ?? "";
}

/** The chat UI document a message shows: its `ui` block, or a completed `show_ui` call's. */
export function uiOf(message: ChatUiMessage | undefined): UiDocument | undefined {
    for (const block of message?.content ?? []) {
        if (block.type === "ui" && block.ui !== undefined) return block.ui;
        if (block.type === "tool_call" && block.presentation?.type === "ui") {
            return block.presentation.ui;
        }
    }
    return undefined;
}

/**
 * The replies a message suggests: its `quick_replies` block, or a completed `suggest_replies`
 * call's presentation, with the call's ID that `quickReply` names.
 */
export function repliesOf(
    message: ChatUiMessage | undefined,
): { readonly options: readonly string[]; readonly toolCallId?: string } | undefined {
    for (const block of message?.content ?? []) {
        if (block.type === "quick_replies" && block.options !== undefined) {
            return { options: block.options };
        }
        if (block.type === "tool_call" && block.presentation?.type === "quick_replies") {
            return { options: block.presentation.options ?? [], toolCallId: block["id"] as string };
        }
    }
    return undefined;
}

/** The conversation's message that shows a document, once there is one. */
export async function shownIn(
    gym: AgentGym,
    agentId: string,
    client: HappyAgentClient = gym.client,
): Promise<ChatUiMessage> {
    return await gym.waitUntil(
        async () =>
            (await messagesOf(gym, agentId, client)).find((message) => uiOf(message) !== undefined),
        "the document to be shown",
    );
}

let actions = 0;

/** A fresh action ID, which the daemon keeps as the attempt record's. */
export function actionId(): string {
    actions += 1;
    return `act${String(actions).padStart(4, "0")}${Math.random().toString(36).slice(2, 12)}`;
}

/** One click on `componentId` of the document `message` shows. */
export function actionOn(
    message: ChatUiMessage,
    componentId: string,
    type: string,
    payload: Record<string, unknown>,
    id: string = actionId(),
): UiActionRequest {
    const ui = uiOf(message);
    if (ui === undefined) throw new Error("The message shows no document.");
    return { id, messageId: message.id, uiId: ui.id, componentId, action: { type, payload } };
}

/** Whether a request is the daemon naming a conversation rather than a turn of its model. */
export function isTitleRequest(request: GymInferenceRequest): boolean {
    return request.sessionId.startsWith("naming:") || request.sessionId.endsWith(":title");
}

/** A model that answers every message by showing `components`, and says nothing afterwards. */
export function showing(
    components: readonly Record<string, unknown>[],
    text = "Here you go.",
): (request: GymInferenceRequest) => GymTurn {
    return (request) => {
        if (isTitleRequest(request)) {
            return {
                content: [{ type: "text", text: "<title>Chat UI</title><slug>chat-ui</slug>" }],
            };
        }
        if (request.messages.at(-1)?.role === "tool") return { content: [] };
        return {
            content: [
                { type: "text", text },
                { type: "tool_call", name: "show_ui", arguments: { components } },
            ],
        };
    };
}

/** Tap the reply `message` suggests at `index`: an ordinary send of its text, naming it. */
export async function tapReply(
    gym: AgentGym,
    agentId: string,
    message: ChatUiMessage,
    index: number,
    extra: { readonly id?: string } = {},
): Promise<SendMessageResponse> {
    const replies = repliesOf(message);
    const text = replies?.options[index];
    if (replies === undefined || text === undefined) {
        throw new Error(`The message suggests no reply ${String(index)}.`);
    }
    const quickReply: QuickReply = {
        messageId: message.id,
        index,
        ...(replies.toolCallId === undefined ? {} : { toolCallId: replies.toolCallId }),
    };
    return await gym.client.sendMessage(agentId, {
        ...(extra.id === undefined ? {} : { id: extra.id }),
        text,
        quickReply,
        mode: { ...gym.selection, permissionMode: "auto" },
    });
}
