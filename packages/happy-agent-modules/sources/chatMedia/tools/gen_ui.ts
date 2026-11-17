import { defineAgentTool } from "@slopus/happy-agent-base";
import { genUiPresentationSchema } from "@slopus/happy-agent-client";
import { Type } from "@sinclair/typebox";

import { compileChatGenUi } from "../impl/compileChatGenUi.js";

/** Show existing Gen UI directly in the response, with no artifact or external side effect. */
export function genUiTool() {
    return defineAgentTool({
        name: "gen_ui",
        defer: true,
        capabilities: ["Show generated native UI directly in a chat message."],
        searchKeywords: [
            "generated UI",
            "inline chart",
            "stats",
            "choices",
            "buttons",
            "native card",
        ],
        description:
            'Show Gen UI directly in this chat, like a picture, without creating an artifact. Pass the root node directly as the tool arguments: {"type":"stat","label":"Revenue","value":"$1.24M"}. Do not wrap it in document, genui, or root, or serialize it as a string. Use it when structure helps: stats, charts, tables, lists, steps, choices, or buttons. Read genui/USAGE.md beside the Happy Agent documentation README and genui/components/<type>.md for component props. The internally constructed authoring document may hold at most 200 nodes, depth 6, and 256 KiB of compact UTF-8 JSON. Images are not supported here; use present_files for pictures. Actions may only be message (sends text to this conversation), open (absolute HTTPS URL without credentials), or copy. Markdown links must also be HTTPS without credentials. Secret forms, plugins, and tool execution are not supported. The result is shown only in this chat, not any parent or child chat. Do not repeat the view in prose; give its main takeaway in your final reply.',
        parameters: Type.Object(
            { type: Type.String({ minLength: 1 }) },
            { additionalProperties: true },
        ),
        returnType: Type.Object({
            shown: Type.Literal(true),
            presentation: genUiPresentationSchema,
        }),
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (_ctx, input) => ({
            shown: true as const,
            presentation: compileChatGenUi(JSON.stringify({ genui: 1, root: input })),
        }),
        toLLM: (result) => [
            {
                type: "text" as const,
                text: `The user sees this Gen UI directly in this chat; no artifact was created.${result.presentation.document.fallback === undefined ? "" : ` ${result.presentation.document.fallback}`}`,
            },
        ],
    });
}
