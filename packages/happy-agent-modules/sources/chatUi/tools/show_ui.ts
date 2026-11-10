import { defineAgentTool } from "@slopus/happy-agent-base";
import { uiSlugSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";

import { historyUiPresentationSchema, type HistoryUiPresentation } from "../../history/index.js";
import type { ChatUiModule } from "../ChatUiModule.js";
import { SHOW_UI_TOOL } from "../impl/findOffer.js";

/** What a `show_ui` call returns: the document it showed, and nothing of any other tool's. */
const showUiResultSchema = Type.Object(
    { presentation: historyUiPresentationSchema },
    { additionalProperties: false },
);

/**
 * Show chat UI to the person: a flat list of the components this server serves. The arguments are
 * checked against each component's bundle and its module's own checks; any problem fails the call
 * with every problem listed, so the model can correct itself, and nothing is shown.
 */
export function showUiTool(chatUi: ChatUiModule, agentId: string) {
    const served = chatUi.prompts();
    const catalog = served
        .map(
            ({ bundle, prompt }) =>
                `- ${bundle.type}: ${prompt}\n  props: ${describeProps(bundle.input)}`,
        )
        .join("\n");
    return defineAgentTool({
        name: SHOW_UI_TOOL,
        defer: true,
        capabilities: [
            "Show files and pictures together, a file tree, and live controls in the chat.",
        ],
        searchKeywords: ["image grid", "media", "file tree", "controls", "ui", "widget"],
        description: `Show the person interactive UI in this chat: a flat list of 1 to 16 components, drawn top to bottom under your message, with no nesting and no styling. This is the only way to show controls; HTML or JSON in your reply is never drawn.

Write your words in your reply as usual and use show_ui for what the person can look at or use. Each component has an id unique in the call, a type, and the props for that type. Labels and details are plain text, never Markdown or links. Live controls do their work themselves and report what happened to you as a hidden note. To offer answers the person can send, use suggest_replies instead.

Components:
${catalog}`,
        parameters: Type.Object(
            {
                components: Type.Array(
                    Type.Object(
                        {
                            id: uiSlugSchema,
                            type: Type.Union(served.map(({ bundle }) => Type.Literal(bundle.type))),
                            props: Type.Record(Type.String(), Type.Unknown(), {
                                description: "The props of that component type, as listed above.",
                            }),
                        },
                        { additionalProperties: false },
                    ),
                    { minItems: 1, maxItems: 16 },
                ),
            },
            { additionalProperties: false },
        ),
        returnType: showUiResultSchema,
        durable: true,
        shouldReviewInAutoMode: ({ components }, ctx) =>
            chatUi.shouldReview(ctx, agentId, components),
        shouldRunInFullAccessInAutoMode: ({ components }, ctx) =>
            chatUi.shouldReview(ctx, agentId, components),
        describeAutoPermissionAction: ({ components }) =>
            chatUi.describeReview(components.map((component) => component.type)),
        execute: async (ctx, { components }) => {
            const built = await chatUi.document(ctx, agentId, components);
            if ("problems" in built) {
                throw new Error(
                    `Nothing was shown. Fix these and call show_ui again:\n- ${built.problems.join("\n- ")}`,
                );
            }
            const presentation: HistoryUiPresentation = {
                type: "ui",
                ui: built.document,
                items: [...built.items],
            };
            return { presentation };
        },
        toLLM: ({ presentation }) => {
            const lines = presentation.ui.components.map(
                (component) => `- ${component.id} (${component.type}): ${component.fallback}`,
            );
            return [
                {
                    type: "text",
                    text: `Shown to the person in this chat, under your message:\n${lines.join("\n")}\nThey see it now, so do not describe it again in your reply. What they do with it reaches you as a hidden note.`,
                },
            ];
        },
    });
}

/** A props schema as compact JSON, without the character patterns every string carries. */
function describeProps(schema: unknown): string {
    return JSON.stringify(schema, (key, value: unknown) =>
        key === "pattern" || key === "additionalProperties" ? undefined : value,
    );
}
