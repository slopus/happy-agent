import { cuid2Schema, defineAgentTool, type AnyAgentTool } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { taskLoopInReasonSchema } from "../../tasks/index.js";
import { SIDEBAR_STYLES } from "../impl/sidebarStyles.js";
import { spaceIconSlugSchema } from "../Space.js";
import type { SpacesModule } from "../SpacesModule.js";
import { requestSpacePlacementTool } from "./request_space_placement.js";

const resultSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
const toLLM = (result: Static<typeof resultSchema>) => [
    { type: "text" as const, text: result.text },
];
const emptySchema = Type.Object({}, { additionalProperties: false });
const editsSchema = Type.Object(
    {
        baseVersion: Type.Integer({ minimum: 1 }),
        edits: Type.Array(
            Type.Object(
                {
                    oldText: Type.String({ minLength: 1, maxLength: 131072 }),
                    newText: Type.String({ maxLength: 131072 }),
                },
                { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 64 },
        ),
    },
    { additionalProperties: false },
);
const conversationsSchema = Type.Object(
    {
        ids: Type.Array(cuid2Schema, { minItems: 1, maxItems: 12, uniqueItems: true }),
        turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
        replies: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
    },
    { additionalProperties: false },
);
const proposeSchema = Type.Object(
    {
        baseVersion: editsSchema.properties.baseVersion,
        edits: Type.Array(editsSchema.properties.edits.items, { maxItems: 64 }),
        newRows: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        id: Type.String({
                            minLength: 1,
                            maxLength: 64,
                            description:
                                "A name you choose, new- then lowercase words joined by hyphens (new-release-ci), the id your edits give its happy-space; or the space ID it was given, to revise it.",
                        }),
                        title: Type.String({ minLength: 1, maxLength: 80 }),
                        icon: spaceIconSlugSchema,
                        why: Type.Optional(
                            Type.String({
                                minLength: 1,
                                maxLength: 160,
                                description: "A few words on where you saw the work.",
                            }),
                        ),
                        firstMessage: Type.String({
                            minLength: 1,
                            maxLength: 2_000,
                            description:
                                "What the new chat is sent as the person's first message when they accept, read-only: ask for a plan and to wait for them before changing anything.",
                        }),
                    },
                    { additionalProperties: false },
                ),
                { maxItems: 16 },
            ),
        ),
    },
    { additionalProperties: false },
);
const proposalPresentationSchema = Type.Object(
    {
        type: Type.Literal("artifact"),
        artifactId: cuid2Schema,
        version: Type.Integer({ minimum: 1 }),
        artifactType: Type.Literal("sidebar_proposal"),
        title: Type.String({ minLength: 1, maxLength: 256 }),
        shows: Type.Literal("latest"),
    },
    { additionalProperties: false },
);
const proposalResultSchema = Type.Object(
    { text: Type.String(), presentation: Type.Optional(proposalPresentationSchema) },
    { additionalProperties: false },
);
const archiveShippedSchema = Type.Object(
    {
        spaceId: cuid2Schema,
        shipped: Type.String({ minLength: 1, maxLength: 500 }),
    },
    { additionalProperties: false },
);
const joinTaskSchema = Type.Object(
    { taskId: cuid2Schema, note: taskLoopInReasonSchema },
    { additionalProperties: false },
);
const iconSchema = Type.Object(
    { spaceId: cuid2Schema, slug: spaceIconSlugSchema },
    { additionalProperties: false },
);

/** One fixed tool surface; layout changes are queued until its turn ends, or proposed. */
export function prioritizingTools(
    spaces: SpacesModule,
    ownerUserId: string,
    agentId: string,
    options: { readonly discovery: boolean },
): AnyAgentTool[] {
    return [
        // Only once the person agreed in onboarding to have their work read.
        ...(options.discovery
            ? [
                  defineAgentTool({
                      name: "discover_work",
                      defer: false,
                      capabilities: [
                          "Read what the person has been working on, from the places Happy disclosed.",
                      ],
                      description:
                          "Read what the person has been working on, read-only, from exactly the places Happy disclosed in onboarding and they agreed to: their connected assistant's own sessions (which projects, and the first thing asked in each) and the recent commit subjects and branch names of those projects. Answers with what it found, or that it found nothing.",
                      parameters: emptySchema,
                      returnType: resultSchema,
                      durable: true,
                      shouldReviewInAutoMode: () => false,
                      execute: async (ctx) => ({ text: await spaces.discover(ctx, ownerUserId) }),
                      toLLM,
                  }),
              ]
            : []),
        listSidebarTool(spaces, ownerUserId),
        readConversationsTool(spaces, ownerUserId, "rows"),
        defineAgentTool({
            name: "propose_sidebar",
            defer: false,
            capabilities: ["Propose a larger sidebar change for the person to accept."],
            description:
                'Propose a change the person accepts with Good to go: exact-text edits, each oldText occurring once. With no open proposal they apply to the sidebar as list_sidebar shows it and baseVersion is its version; otherwise they revise list_sidebar\'s proposal and baseVersion is the proposal\'s version. Rows under <happy-section id="archive" label="Archive"/> are archived on accept. newRows offers chats the person does not have yet: place each with <happy-space id="new-…"/> at the top level in your edits; accepting creates it there and sends its first message read-only. The proposal shows inline in your conversation. Edits that override the person\'s edits of the proposal are dropped with a note.',
            parameters: proposeSchema,
            returnType: proposalResultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof proposeSchema>, call) => {
                const result = await spaces.proposeSidebar(ctx, ownerUserId, input, call.id);
                return {
                    text: result.text,
                    ...(result.artifact === undefined
                        ? {}
                        : {
                              presentation: {
                                  type: "artifact" as const,
                                  artifactId: result.artifact.id,
                                  version: result.artifact.latestVersion,
                                  artifactType: "sidebar_proposal" as const,
                                  title: result.artifact.title,
                                  shows: "latest" as const,
                              },
                          }),
                };
            },
            toLLM: (result) => [{ type: "text" as const, text: result.text }],
        }),
        defineAgentTool({
            name: "edit_sidebar",
            defer: false,
            capabilities: ["Edit the person's sidebar artifact."],
            description:
                "Apply sequential exact-text edits to the sidebar document. Each oldText must occur exactly once. All edits make one immutable version when the calm batch applies. Read again on a stale baseVersion. Only placing new work, adding Distractions, adding or moving your own row, and changes nested under a row apply without the person asking; anything else, and anything touching the person's moves, folds, names, or widgets, is dropped with a note, and the rest still queues.",
            parameters: editsSchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof editsSchema>, call) => ({
                text: await spaces.editSidebar(ctx, ownerUserId, input, call.id),
            }),
            toLLM,
        }),
        sidebarStylesTool(),
        defineAgentTool({
            name: "archive_shipped_task",
            defer: false,
            capabilities: ["Archive a task whose work has shipped."],
            description:
                "Archive the task behind a row (its space ID) now, because its work explicitly shipped or finished. shipped says what shipped, in one sentence. Only task rows the person may archive; its conversation and folder are kept and the person can restore it. Anything that has not shipped goes in a proposal's Archive block instead.",
            parameters: archiveShippedSchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof archiveShippedSchema>) => ({
                text: await spaces.archiveShippedTask(ctx, ownerUserId, input.spaceId),
            }),
            toLLM,
        }),
        defineAgentTool({
            name: "join_task",
            defer: false,
            capabilities: ["Add a task a teammate's agent mentioned the person in to their list."],
            description:
                "Join the person to a task a teammate's agent mentioned them in, by its task ID from the notice, and mark it new for them on every device. note says why it concerns them, in one sentence they read. Its row then arrives as new work for you to place.",
            parameters: joinTaskSchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof joinTaskSchema>) => ({
                text: await spaces.joinTask(ctx, ownerUserId, agentId, input.taskId, input.note),
            }),
            toLLM,
        }),
        defineAgentTool({
            name: "set_space_icon",
            defer: false,
            capabilities: ["Set the icon of a sidebar row or a session under it."],
            description:
                "Set an icon from the icon library on a row (its space ID) or a session under a row (its agent ID), shown or not. Applies immediately because it moves nothing. New work without a first message keeps its stem-cell mark.",
            parameters: iconSchema,
            returnType: resultSchema,
            durable: true,
            shouldReviewInAutoMode: () => false,
            execute: async (ctx, input: Static<typeof iconSchema>) => ({
                text: await spaces.setIcon(ctx, ownerUserId, input.spaceId, input.slug),
            }),
            toLLM,
        }),
        ...spaces.sidebarArtifactTools(agentId),
    ];
}

/**
 * Voice's fixed sidebar surface: Prioritizing's own read tools, and requests to Prioritizing for
 * any rearrangement. Voice never edits the sidebar itself.
 */
export function voiceSidebarTools(
    spaces: SpacesModule,
    ownerUserId: string,
    agentId: string,
): AnyAgentTool[] {
    return [
        listSidebarTool(spaces, ownerUserId),
        readConversationsTool(spaces, ownerUserId, "machine"),
        sidebarStylesTool(),
        // Voice's array is fixed and complete, so the request is offered directly.
        { ...requestSpacePlacementTool(spaces, agentId), defer: false },
        requestSidebarTidyTool(spaces, ownerUserId),
    ];
}

export function listSidebarTool(spaces: SpacesModule, ownerUserId: string): AnyAgentTool {
    return defineAgentTool({
        name: "list_sidebar",
        defer: false,
        capabilities: ["Read the person's sidebar artifact and live spaces."],
        description:
            "Read {artifactId, version, html, spaces, sessions, visibleRows, manualIds}. The html is the sidebar exactly as the person sees it. spaces describe each row, with the agent ID of its conversation; sessions list every session under the rows with its parent, whether or not it is shown. visibleRows counts the rows and widgets shown outside collapsed sections and the sessions shown under them, not counting Happy and new work waiting for its first message, against the budget to stay within. manualIds are the items whose place, fold, name, or content the person last set; keepInPlace marks the rows they keep above the first separator. proposal is your open proposal, if any, with when it was opened. Pending edits are included with the version your next edit must use.",
        parameters: emptySchema,
        returnType: resultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => ({
            text: JSON.stringify(await spaces.prioritizingSidebar(ctx, ownerUserId)),
        }),
        toLLM,
    });
}

/**
 * Prioritizing reads the person's rows and the sessions under them; Voice may read any
 * conversation on this machine the person can see.
 */
export function readConversationsTool(
    spaces: SpacesModule,
    ownerUserId: string,
    scope: "rows" | "machine",
): AnyAgentTool {
    return defineAgentTool({
        name: "read_conversations",
        defer: false,
        capabilities: ["Read what was said in several sidebar rows' conversations."],
        description: `Read up to 12 conversations at once, each a row (its space ID) or ${scope === "rows" ? "a session under a row" : "any conversation on this machine"} (its agent ID): its title, when it was last active, and its latest turns (default 4), oldest first. A turn is a message from the person or another agent (such as a subtask's task or report) with the agent's last replies to it (default 1). Tool calls, their output, and reasoning are left out, and long messages are shortened.`,
        parameters: conversationsSchema,
        returnType: resultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: Static<typeof conversationsSchema>) => ({
            text: await spaces.readConversations(ctx, ownerUserId, {
                ids: input.ids,
                turns: input.turns ?? 4,
                replies: input.replies ?? 1,
                scope,
            }),
        }),
        toLLM,
    });
}

export function sidebarStylesTool(): AnyAgentTool {
    return defineAgentTool({
        name: "get_sidebar_styles",
        defer: false,
        capabilities: ["Read the sidebar document's grammar."],
        description:
            "Read the sidebar's allowed elements, their attributes and children, and its rules. The app draws every element itself; nothing else is allowed.",
        parameters: emptySchema,
        returnType: resultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async () => ({ text: JSON.stringify(SIDEBAR_STYLES) }),
        toLLM,
    });
}

/** The person's Tidy button, asked for in words: one message in Prioritizing's conversation. */
function requestSidebarTidyTool(spaces: SpacesModule, ownerUserId: string): AnyAgentTool {
    return defineAgentTool({
        name: "request_sidebar_tidy",
        defer: false,
        capabilities: ["Ask Focus to tidy the person's whole sidebar."],
        description:
            "Ask Focus, the helper that organises the person's sidebar, to tidy the whole sidebar now, as the person's Tidy button does. Use request_space_placement instead to move one conversation's row.",
        parameters: emptySchema,
        returnType: resultSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => ({
            text: (await spaces.requestTidy(ctx, ownerUserId))
                ? "Focus was asked to tidy the sidebar and decides shortly."
                : "Nothing organizes this sidebar yet; the person can tidy it themselves.",
        }),
        toLLM,
    });
}
