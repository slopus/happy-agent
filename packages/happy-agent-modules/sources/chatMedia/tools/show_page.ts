import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";

/** How a page asks to be shown, as an artifact's display preference does. */
const pageDisplaySchema = Type.Union(
    [Type.Literal("inline_compact"), Type.Literal("inline_expanded"), Type.Literal("side")],
    {
        description:
            'How the chat shows it: "inline_expanded" (the default) at its full height in the chat, "inline_compact" collapsed to its title until the user expands it, or "side" as its title, opened beside the chat',
    },
);

const showPageArgumentsSchema = Type.Object(
    {
        url: Type.String({
            minLength: 1,
            maxLength: 4096,
            description:
                "An http or https URL as your machine reaches it, such as http://localhost:5173/ for a dev server you started",
        }),
        title: Type.String({
            minLength: 1,
            maxLength: 256,
            description: "What the page is, in a few words the user reads beside it",
        }),
        display: Type.Optional(pageDisplaySchema),
    },
    { additionalProperties: false },
);

type ShowPageArguments = Static<typeof showPageArgumentsSchema>;

const showPageResultSchema = Type.Object(
    {
        presentation: Type.Object(
            {
                type: Type.Literal("page"),
                url: Type.String(),
                title: Type.String(),
                display: Type.Union([pageDisplaySchema, Type.Null()]),
            },
            { additionalProperties: false },
        ),
    },
    { additionalProperties: false },
);

/**
 * Show a web page inline in this chat. Only the presentation is recorded: the daemon never
 * fetches the page, and the client opens it through this agent's network, so `localhost` is the
 * agent's own machine.
 */
export function showPageTool() {
    return defineAgentTool({
        name: "show_page",
        defer: true,
        capabilities: ["Show a web page, such as a running dev server, inline in the chat."],
        searchKeywords: [
            "show page",
            "preview url",
            "show dev server",
            "embed website",
            "inline page",
        ],
        description: `Show a web page to the user inline in this chat, at its full height, such as the dev server of an app you are building or a page you want the user to look at and use.

The URL is opened as your machine reaches it, so http://localhost:<port>/ shows a server you started. The page runs as it is, scripts included, in a sandbox of its own, and the user can use it in place or open it beside the chat. To show something you make yourself, write an html artifact instead: it is versioned, and the user sees every change you make to it.`,
        parameters: showPageArgumentsSchema,
        returnType: showPageResultSchema,
        durable: true,
        // The page runs its own scripts in the user's client, through this agent's network, so
        // the reviewer decides on every address before it is shown.
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ url, title }) =>
            `showing the web page at ${quoteVisibleExact(url)}, titled ${quoteVisibleExact(title)}, inline in this chat. The user's client loads it through this agent's network, so it can reach servers on the agent's machine and the internet, and runs the page's own scripts`,
        execute: async (_ctx, input: ShowPageArguments) => {
            let address: URL;
            try {
                address = new URL(input.url);
            } catch {
                throw new Error(`${JSON.stringify(input.url)} is not a URL.`);
            }
            if (address.protocol !== "http:" && address.protocol !== "https:") {
                throw new Error("Only http and https pages can be shown in the chat.");
            }
            if (address.username !== "" || address.password !== "") {
                throw new Error("A page shown in the chat cannot carry a user name or password.");
            }
            if (address.href.length > 4096)
                throw new Error("The URL is longer than 4,096 characters.");
            return {
                presentation: {
                    type: "page" as const,
                    url: address.href,
                    title: input.title,
                    display: input.display ?? null,
                },
            };
        },
        toLLM: ({ presentation }) => [
            {
                type: "text",
                text: `Showing ${JSON.stringify(presentation.title)} (${presentation.url}) to the user in this chat${presentation.display === null ? "" : `, ${presentation.display}`}. The user sees it now, so do not describe it as if they cannot. It appears only in this chat's history.`,
            },
        ],
    });
}
