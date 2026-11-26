import { AgentKV, AgentProviders } from "@slopus/happy-agent-base";
import type { MessageMode } from "@slopus/happy-agent-client";
import type { BaseProvider, SessionEvent, SessionUserMessage } from "@slopus/happy-providers";

import { InMemoryPersistence } from "./InMemoryPersistence.js";

/** A registry holding the one provider under the ID `"scripted"` that a test configures. */
export function providersOf(provider: BaseProvider): AgentProviders {
    const providers = new AgentProviders();
    providers.add("scripted", provider, "gym");
    return providers;
}

/** The mode a test projects onto a user message stored without one. */
export function defaultMode(): MessageMode {
    return {
        providerId: "codex",
        modelId: "openai/gpt-5.6-sol",
        effort: "medium",
        serviceTier: null,
        permissionMode: "auto",
    };
}

/** A store standing in for the one a collection shares between its agents. */
export function sharedKV(): AgentKV {
    return new AgentKV(new InMemoryPersistence(), "shared.");
}

/** A complete scripted turn that answers with text and ends normally. */
export function textTurn(text: string): SessionEvent[] {
    return [
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
    ];
}

/** A scripted turn that calls one tool and stops for its result. */
export function toolCallTurn(callId: string, name: string, argumentsJson: string): SessionEvent[] {
    return [
        { type: "toolcall_start", callId, name },
        { type: "toolcall_end", callId, arguments: argumentsJson },
        { type: "done", state: "tool_call", tokens: { input: 1, output: 1 } },
    ];
}

export function user(text: string): SessionUserMessage {
    return { role: "user", content: [{ type: "text", text }] };
}
