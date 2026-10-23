/**
 * Messages and runs: what the user sends, and the work the agent does in response.
 *
 * One message shape carries the whole conversation — history, send acceptances,
 * and events all speak it.
 */

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    cuid2Schema,
    eventCursorSchema,
    messageModeSchema,
    Nullable,
    timestampSchema,
    type Cuid2,
    type EventCursor,
    type MessageMode,
    type Timestamp,
} from "./common.js";
import { artifactDisplaySchema, artifactTitleSchema, artifactTypeSchema } from "./artifacts.js";
import { mediaLayoutStyleSchema } from "./mediaLayoutStyle.js";
import type { UsageBreakdown } from "./usage.js";
import { userIdSchema } from "./users.js";

/** One read the exploration performed: a listing, a file read, or a search. */
export const explorationOperationSchema = Type.Union([
    Type.Object({ kind: Type.Literal("list"), target: Type.String() }),
    Type.Object({ kind: Type.Literal("read"), name: Type.String() }),
    Type.Object({
        command: Type.String(),
        kind: Type.Literal("search"),
        path: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
    }),
]);

/** One read the exploration performed: a listing, a file read, or a search. */
export type ExplorationOperation = Static<typeof explorationOperationSchema>;

/** Reading around the codebase: listings, file reads, and searches. */
export const explorationPresentationSchema = Type.Object({
    operations: Type.Array(explorationOperationSchema),
    type: Type.Literal("exploration"),
});

/** Reading around the codebase: listings, file reads, and searches. */
export type ExplorationPresentation = Static<typeof explorationPresentationSchema>;

/** A shell command; `output` arrives on completion. */
export const execCommandPresentationSchema = Type.Object({
    command: Type.String(),
    output: Type.Optional(Nullable(Type.String())),
    /** Set when the command kept running and became a background terminal. */
    terminalId: Type.Optional(Nullable(cuid2Schema)),
    type: Type.Literal("exec_command"),
});

/** A shell command; `output` arrives on completion. */
export type ExecCommandPresentation = Static<typeof execCommandPresentationSchema>;

/** Input typed into an existing background terminal. */
export const backgroundTerminalInteractionPresentationSchema = Type.Object({
    /** What the terminal is running. */
    command: Type.String(),
    /** What was typed into it. */
    input: Type.String(),
    terminalId: cuid2Schema,
    type: Type.Literal("background_terminal_interaction"),
});

/** Input typed into an existing background terminal. */
export type BackgroundTerminalInteractionPresentation = Static<
    typeof backgroundTerminalInteractionPresentationSchema
>;

/** One line of a hunk. */
export const fileDiffLineSchema = Type.Object({
    kind: Type.Union([Type.Literal("context"), Type.Literal("add"), Type.Literal("delete")]),
    text: Type.String(),
});

/** One line of a hunk. */
export type FileDiffLine = Static<typeof fileDiffLineSchema>;

/** A contiguous run of diff lines, numbered against both sides. */
export const fileDiffHunkSchema = Type.Object({
    lines: Type.Array(fileDiffLineSchema),
    newStart: Type.Integer({ minimum: 0 }),
    oldStart: Type.Integer({ minimum: 0 }),
});

/** A contiguous run of diff lines, numbered against both sides. */
export type FileDiffHunk = Static<typeof fileDiffHunkSchema>;

/** One file's changes inside a diff presentation. */
export const fileDiffSchema = Type.Object({
    added: Type.Integer({ minimum: 0 }),
    deleted: Type.Integer({ minimum: 0 }),
    hunks: Type.Array(fileDiffHunkSchema),
    kind: Type.Union([Type.Literal("add"), Type.Literal("delete"), Type.Literal("update")]),
    /** For syntax highlighting, when the daemon could name the language. */
    language: Type.Optional(Type.String()),
    /** How many lines this file's hunks left out. */
    omittedLines: Type.Optional(Type.Integer({ minimum: 0 })),
    path: Type.String(),
});

/** One file's changes inside a diff presentation. */
export type FileDiff = Static<typeof fileDiffSchema>;

/** File changes, one or many files per call. */
export const fileDiffPresentationSchema = Type.Object({
    files: Type.Array(fileDiffSchema),
    /** How many files the call changed but the presentation left out. */
    omittedFiles: Type.Optional(Type.Integer({ minimum: 0 })),
    type: Type.Literal("file_diff"),
});

/** File changes, one or many files per call. */
export type FileDiffPresentation = Static<typeof fileDiffPresentationSchema>;

/** One source a search drew from. */
export const searchSourceSchema = Type.Object({ title: Type.String(), url: Type.String() });

/** One source a search drew from. */
export type SearchSource = Static<typeof searchSourceSchema>;

/** A web or X search; `sources` arrives on completion. */
export const searchPresentationSchema = Type.Object({
    query: Type.String(),
    sources: Type.Optional(Type.Array(searchSourceSchema)),
    target: Type.Union([Type.Literal("web"), Type.Literal("x")]),
    type: Type.Literal("search"),
});

/** A web or X search; `sources` arrives on completion. */
export type SearchPresentation = Static<typeof searchPresentationSchema>;

/** The exact model/provider pair resolved by the sub-agent creation path. */
export const agentSpawnModelSchema = Type.Object({
    modelId: Type.String({ minLength: 1, maxLength: 256 }),
    providerId: Type.String({ minLength: 1, maxLength: 256 }),
    /** Human-readable catalog name, captured before creation and retained in history. */
    name: Type.String({ minLength: 1, maxLength: 256 }),
});

/** The exact model/provider pair resolved by the sub-agent creation path. */
export type AgentSpawnModel = Static<typeof agentSpawnModelSchema>;

/** Sub-agent creation; the enclosing tool status owns its lifecycle. */
export const agentSpawnPresentationSchema = Type.Object({
    type: Type.Literal("agent_spawn"),
    /** Absent until the creation path has resolved and validated the complete identity. */
    model: Type.Optional(agentSpawnModelSchema),
    /** The child identity, supplied only after creation and initial-task delivery succeed. */
    agentId: Type.Optional(cuid2Schema),
});

/** Sub-agent creation; the enclosing tool status owns its lifecycle. */
export type AgentSpawnPresentation = Static<typeof agentSpawnPresentationSchema>;

const mediaItemNameSchema = Type.String({ minLength: 1, maxLength: 255 });
const mediaItemMimeTypeSchema = Type.String({ minLength: 1, maxLength: 255 });
const mediaItemSizeSchema = Type.Integer({ minimum: 0 });
const mediaItemDimensionSchema = Type.Integer({ minimum: 1 });
const mediaItemThumbhashSchema = Type.String({ minLength: 1, maxLength: 128 });

/**
 * Where an item came from on the agent's machine: `path` exactly as the agent wrote it, such as a
 * read's `file_path`, and `absolutePath`, the file it named. A layout block in the agent's text
 * names the item by either one.
 */
export const mediaItemSourceSchema = Type.Object({
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    absolutePath: Type.String({ minLength: 1, maxLength: 4096 }),
});

/** Where an item came from on the agent's machine. */
export type MediaItemSource = Static<typeof mediaItemSourceSchema>;

/** A decoded picture: always measured, with a ThumbHash to show until its bytes load. */
export const mediaImageItemSchema = Type.Object({
    kind: Type.Literal("image"),
    /** The file's base name, for display and downloads only. */
    name: mediaItemNameSchema,
    /** The decoded format's media type. */
    mimeType: mediaItemMimeTypeSchema,
    size: mediaItemSizeSchema,
    /** Displayed width in pixels, after EXIF orientation. */
    width: mediaItemDimensionSchema,
    /** Displayed height in pixels, after EXIF orientation. */
    height: mediaItemDimensionSchema,
    /** Standard base64 encoding of a ThumbHash placeholder. */
    thumbhash: mediaItemThumbhashSchema,
    /**
     * Pixels per point, from the file's density: 2 for a 144 DPI Retina screenshot. Absent means
     * 1. An image's natural size is its pixel size divided by this.
     */
    scale: Type.Optional(Type.Number({ exclusiveMinimum: 1, maximum: 4 })),
    /** The file it was read, presented, or generated as; absent on older daemons. */
    source: Type.Optional(mediaItemSourceSchema),
});

/** A decoded picture: always measured, with a ThumbHash to show until its bytes load. */
export type MediaImageItem = Static<typeof mediaImageItemSchema>;

/** A video, a PDF document, or any other file; clients render an unknown kind as a file. */
export const mediaFileItemSchema = Type.Object({
    kind: Type.Union([Type.Literal("video"), Type.Literal("document"), Type.Literal("file")]),
    /** The file's base name, for display and downloads only. */
    name: mediaItemNameSchema,
    /** From the file extension; `application/octet-stream` when unknown. */
    mimeType: mediaItemMimeTypeSchema,
    size: mediaItemSizeSchema,
    /** Not currently supplied for these kinds; tolerated when present. */
    width: Type.Optional(mediaItemDimensionSchema),
    /** Not currently supplied for these kinds; tolerated when present. */
    height: Type.Optional(mediaItemDimensionSchema),
    /** Not currently supplied for these kinds; tolerated when present. */
    thumbhash: Type.Optional(mediaItemThumbhashSchema),
    /** The file it was presented as; absent on older daemons. */
    source: Type.Optional(mediaItemSourceSchema),
});

/** A video, a PDF document, or any other file; clients render an unknown kind as a file. */
export type MediaFileItem = Static<typeof mediaFileItemSchema>;

/** One item a call showed inline; its bytes are served by its index. */
export const mediaItemSchema = Type.Union([mediaImageItemSchema, mediaFileItemSchema]);

/** One item a call showed inline; its bytes are served by its index. */
export type MediaItem = Static<typeof mediaItemSchema>;

/** The tags a media layout element may have. */
export const mediaLayoutTagSchema = Type.Union([
    Type.Literal("div"),
    Type.Literal("section"),
    Type.Literal("figure"),
    Type.Literal("figcaption"),
    Type.Literal("p"),
    Type.Literal("span"),
    Type.Literal("strong"),
    Type.Literal("em"),
    Type.Literal("code"),
]);

/** The tags a media layout element may have. */
export type MediaLayoutTag = Static<typeof mediaLayoutTagSchema>;

/**
 * One node of an agent-authored media layout: an element with children, a presented item placed
 * by its index in `items`, plain text, or a line break. Never HTML. An item without a `width`
 * shows at its natural size, shrunk to fit and never enlarged.
 */
export const mediaLayoutNodeSchema = Type.Recursive((node) =>
    Type.Union([
        Type.Object({
            type: Type.Literal("element"),
            tag: mediaLayoutTagSchema,
            style: Type.Optional(mediaLayoutStyleSchema),
            children: Type.Array(node, { maxItems: 500 }),
        }),
        Type.Object({
            type: Type.Literal("item"),
            /** Zero-based index into the presentation's `items`. */
            index: Type.Integer({ minimum: 0, maximum: 9 }),
            alt: Type.Optional(Type.String({ maxLength: 1000 })),
            style: Type.Optional(mediaLayoutStyleSchema),
        }),
        Type.Object({
            type: Type.Literal("text"),
            text: Type.String({ minLength: 1, maxLength: 8000 }),
        }),
        Type.Object({ type: Type.Literal("break") }),
    ]),
);

/** One node of an agent-authored media layout. */
export type MediaLayoutNode = Static<typeof mediaLayoutNodeSchema>;

/**
 * How a media presentation arranges its items: a fixed number of columns, or a layout tree an
 * agent wrote. Absent means the client's automatic layout, and so does a layout a client does not
 * recognize.
 */
export const mediaLayoutSchema = Type.Union([
    Type.Object({
        type: Type.Literal("columns"),
        columns: Type.Union([Type.Literal(1), Type.Literal(2)]),
    }),
    Type.Object({
        type: Type.Literal("tree"),
        root: Type.Array(mediaLayoutNodeSchema, { minItems: 1, maxItems: 500 }),
    }),
]);

/** How a media presentation arranges its items. */
export type MediaLayout = Static<typeof mediaLayoutSchema>;

/**
 * Images, videos, documents, and files a completed call showed the person inline: a generated
 * image, an image the agent read, or files presented with `present_files`. Each item's bytes are
 * `GET /v0/agents/:agentId/tool-calls/:toolCallId/media/:index`.
 */
export const mediaPresentationSchema = Type.Object({
    type: Type.Literal("media"),
    /** One to ten items, in the order presented; the position is the item's media index. */
    items: Type.Array(mediaItemSchema, { minItems: 1, maxItems: 10 }),
    /** How to arrange the items; absent on older daemons and for the automatic layout. */
    layout: Type.Optional(mediaLayoutSchema),
});

/** Images, videos, documents, and files a completed call showed the person inline. */
export type MediaPresentation = Static<typeof mediaPresentationSchema>;

/**
 * Which version an artifact presentation shows: `"latest"` follows the artifact as it changes and is
 * where an HTML artifact is shown inline; `"version"` is exactly the presented one. Absent, or a
 * value this client does not know, means `"version"`.
 */
export const artifactPresentationShowsSchema = Type.Union([
    Type.Literal("latest"),
    Type.Literal("version"),
]);

/** Which version an artifact presentation shows. */
export type ArtifactPresentationShows = Static<typeof artifactPresentationShowsSchema>;

/** An artifact a completed call created, changed, or took up for editing, shown in the chat. */
export const artifactPresentationSchema = Type.Object({
    type: Type.Literal("artifact"),
    artifactId: cuid2Schema,
    /** The artifact's latest version when the call completed. */
    version: Type.Integer({ minimum: 1 }),
    artifactType: artifactTypeSchema,
    /** The artifact's title at that version. */
    title: artifactTitleSchema,
    /** Which version the chat shows; absent on older daemons, meaning `"version"`. */
    shows: Type.Optional(artifactPresentationShowsSchema),
});

/** An artifact a completed call created, changed, or took up for editing, shown in the chat. */
export type ArtifactPresentation = Static<typeof artifactPresentationSchema>;

/**
 * A web page a completed call asked the chat to show inline, at a URL as the agent's own machine
 * reaches it. `display` is an artifact display preference, or `null` for the client's choice.
 * Legacy history and older daemons only: the daemon no longer has `show_page`, and live pages are
 * HTML artifacts with a URL, presented as `artifact` with `shows: "latest"`.
 */
export const pagePresentationSchema = Type.Object({
    type: Type.Literal("page"),
    url: Type.String({ minLength: 1, maxLength: 4096 }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    display: Nullable(artifactDisplaySchema),
});

/** A legacy inline web page. New live pages use `ArtifactPresentation` and the artifact's `live`. */
export type PagePresentation = Static<typeof pagePresentationSchema>;

/** Every display-ready tool-call presentation the client understands. */
export const toolPresentationSchema = Type.Union([
    explorationPresentationSchema,
    execCommandPresentationSchema,
    backgroundTerminalInteractionPresentationSchema,
    fileDiffPresentationSchema,
    searchPresentationSchema,
    agentSpawnPresentationSchema,
    mediaPresentationSchema,
    artifactPresentationSchema,
    pagePresentationSchema,
]);

/** Every display-ready tool-call presentation the client understands. */
export type ToolPresentation = Static<typeof toolPresentationSchema>;

/** Stable provenance carried with a message without exposing internal module metadata. */
export const messageMetadataSchema = Type.Object({
    /** The provider that produced this message, when it came from inference. */
    providerId: Type.Optional(Type.String()),
    /** The model that produced this message, when it came from inference. */
    modelId: Type.Optional(Type.String()),
    /** The agent that sent this system-generated message, when one identified itself. */
    senderAgentId: Type.Optional(cuid2Schema),
    /**
     * The local Happy user ID of the person who wrote a user message: the authenticated team member
     * who submitted it, or the exported-bot guest who wrote it.
     */
    userId: Type.Optional(userIdSchema),
});
export type MessageMetadata = Static<typeof messageMetadataSchema>;

/** One JSON value inside opaque client-owned message metadata. */
export const clientMetadataValueSchema = Type.Recursive((value) =>
    Type.Union([
        Type.String(),
        Type.Number(),
        Type.Boolean(),
        Type.Null(),
        Type.Array(value),
        Type.Record(Type.String(), value),
    ]),
);

/** One JSON value inside opaque client-owned message metadata. */
export type ClientMetadataValue = Static<typeof clientMetadataValueSchema>;

/** Freeform JSON supplied by a client and durably attached to one user message. */
export const clientMetadataSchema = Type.Record(Type.String(), clientMetadataValueSchema);

/** Freeform JSON supplied by a client and durably attached to one user message. */
export type ClientMetadata = Static<typeof clientMetadataSchema>;

/** One execution configuration transition, anchored or kept in its chronological append position. */
export const configurationBlockSchema = Type.Object({
    type: Type.Literal("configuration"),
    /** Null establishes the initial baseline and is not displayed as a change. */
    before: Nullable(messageModeSchema),
    after: messageModeSchema,
    /** Null when there is no suitable message anchor, such as a mid-run account switch. */
    beforeMessageId: Nullable(cuid2Schema),
});
export type ConfigurationBlock = Static<typeof configurationBlockSchema>;

/** Source kinds with understood semantics; unknown wire kinds are still readable. */
export const knownCredentialSourceKindSchema = Type.Union([
    Type.Literal("native_login"),
    Type.Literal("configuration"),
    Type.Literal("environment"),
]);
export type KnownCredentialSourceKind = Static<typeof knownCredentialSourceKindSchema>;

/** A safe description of the actual source, never credential values or file paths. */
export const credentialSourceSchema = Type.Object({
    /** Extensible wire value. Unknown kinds never imply a known source-specific remedy. */
    kind: Type.String({ minLength: 1, maxLength: 64 }),
    location: Type.String({ minLength: 1, maxLength: 256 }),
    /** Human-readable host label; null when unavailable or not authorized. */
    host: Nullable(Type.String({ minLength: 1, maxLength: 256 })),
});
export type CredentialSource = Static<typeof credentialSourceSchema>;

/** Closed allowlist of actions this client knows how to offer; every one requires a click. */
export const knownErrorRecoveryActionSchema = Type.Literal("ask_chief");
export type KnownErrorRecoveryAction = Static<typeof knownErrorRecoveryActionSchema>;

/** Extensible wire value. Ignore unrecognized actions instead of executing or guessing them. */
export const errorRecoveryActionSchema = Type.String({ minLength: 1, maxLength: 64 });
export type ErrorRecoveryAction = Static<typeof errorRecoveryActionSchema>;

/** A daemon-curated manual command to display and copy, never execute automatically. */
export const errorRecoveryCommandSchema = Type.Object({
    label: Type.String({ minLength: 1, maxLength: 128 }),
    command: Type.String({ minLength: 1, maxLength: 2_048 }),
});
export type ErrorRecoveryCommand = Static<typeof errorRecoveryCommandSchema>;

/** Bounded, source-specific manual guidance alongside the existing full error text. */
export const errorRecoverySchema = Type.Object({
    steps: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), { maxItems: 8 }),
    actions: Type.Array(errorRecoveryActionSchema, { maxItems: 8, uniqueItems: true }),
    commands: Type.Optional(Type.Array(errorRecoveryCommandSchema, { maxItems: 8 })),
});
export type ErrorRecovery = Static<typeof errorRecoverySchema>;

/** Optional diagnostic data on an ordinary error service message. */
export const messageErrorSchema = Type.Object({
    /** Stable and extensible; never classify failures by matching display text. */
    code: Type.String({ minLength: 1, maxLength: 128 }),
    /** The actual failed attempt, not a later route or current composer selection. */
    mode: Nullable(messageModeSchema),
    credentialSource: Nullable(credentialSourceSchema),
    recovery: errorRecoverySchema,
});
export type MessageError = Static<typeof messageErrorSchema>;

/** Failure kinds with understood remedies; unknown wire kinds are still readable. */
export const knownMessageFailureKindSchema = Type.Union([
    Type.Literal("signin_missing"),
    Type.Literal("usage_limit"),
    Type.Literal("no_account_available"),
    Type.Literal("rate_limited"),
    Type.Literal("provider_unavailable"),
    Type.Literal("network"),
    Type.Literal("context_too_long"),
    Type.Literal("provider_disabled"),
    Type.Literal("internal"),
]);
export type KnownMessageFailureKind = Static<typeof knownMessageFailureKindSchema>;

/** The provider entry a failure is about. Display text is daemon-supplied, never inferred. */
export const messageFailureProviderSchema = Type.Object({
    id: Type.String({ minLength: 1, maxLength: 256 }),
    /** Canonical family such as `claude`, `codex`, `grok`, or `bedrock`; extensible. */
    type: Type.String({ minLength: 1, maxLength: 128 }),
    /** The vendor as people say it in a sentence: "Claude", "Codex", "Grok", "Bedrock". */
    vendorName: Type.String({ minLength: 1, maxLength: 128 }),
    /** The configured provider entry's display label, such as "claude_work". */
    label: Type.String({ minLength: 1, maxLength: 256 }),
});
export type MessageFailureProvider = Static<typeof messageFailureProviderSchema>;

/** Ranking groups with understood labels; unknown wire values are still readable. */
export const knownFallbackGroupSchema = Type.Union([
    Type.Literal("same_model"),
    Type.Literal("same_family"),
    Type.Literal("other_provider"),
]);
export type KnownFallbackGroup = Static<typeof knownFallbackGroupSchema>;

/**
 * One account and model to switch to, as daemons before protocol 32 ranked them. From protocol 32
 * failures carry none; clients take switch targets from the live model catalog and usage.
 */
export const messageFailureFallbackSchema = Type.Object({
    providerId: Type.String({ minLength: 1, maxLength: 256 }),
    /** The provider entry's display label, such as "claude_work". */
    providerLabel: Type.String({ minLength: 1, maxLength: 256 }),
    /** Clients name the model from the model catalog. */
    modelId: Type.String({ minLength: 1, maxLength: 256 }),
    /** Percentage of one usage window already used; null without a fresh reading. */
    usedPercent: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
    /** Lowercase name of the window `usedPercent` comes from, such as "weekly" or "5h". */
    usageWindow: Nullable(Type.String({ minLength: 1, maxLength: 64 })),
    /** Ranking group; menus label groups only when more than one is present. */
    group: Type.String({ minLength: 1, maxLength: 64 }),
});
export type MessageFailureFallback = Static<typeof messageFailureFallbackSchema>;

const resolutionBaseSchema = Type.Object({ at: timestampSchema });

/** The failed turn was sent again on the same route. */
export const retriedResolutionSchema = Type.Composite([
    resolutionBaseSchema,
    Type.Object({ action: Type.Literal("retried") }),
]);

/** The chat moved to another route and the turn continued there. */
export const switchedResolutionSchema = Type.Composite([
    resolutionBaseSchema,
    Type.Object({
        action: Type.Literal("switched"),
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
    }),
]);

/** A resolution action this client does not know; it still shows that the failure was handled. */
export const otherResolutionSchema = Type.Composite([
    resolutionBaseSchema,
    Type.Object({ action: Type.String({ minLength: 1, maxLength: 64 }) }),
]);

/** What the person did about a failure. The failed message stays in history and records it. */
export const messageFailureResolutionSchema = Type.Union([
    retriedResolutionSchema,
    switchedResolutionSchema,
    otherResolutionSchema,
]);
export type MessageFailureResolution =
    | Static<typeof retriedResolutionSchema>
    | Static<typeof switchedResolutionSchema>
    | (Static<typeof otherResolutionSchema> & { action: string & {} });

/** Fields every failure carries, whatever its kind. */
const failureBaseSchema = Type.Object({
    /** One user-safe sentence without a clock time, for agents and unknown kinds. */
    message: Type.String({ minLength: 1, maxLength: 512 }),
    /**
     * Always empty from protocol 32, whose clients take switch targets from the live model catalog
     * and usage. Older daemons send ranked alternatives and accept only those on `switch`.
     */
    fallbackProviders: Type.Array(messageFailureFallbackSchema, { maxItems: 16 }),
    /** Absent until the person retries or switches. */
    resolution: Type.Optional(messageFailureResolutionSchema),
});

const failureVariant = <K extends string, F extends Record<string, TSchema>>(kind: K, fields: F) =>
    Type.Composite([failureBaseSchema, Type.Object({ kind: Type.Literal(kind), ...fields })]);

/** When the spent limit resets, Unix milliseconds; clients format it in the viewer's local time. */
const resetsAtSchema = Nullable(timestampSchema);

export const signinMissingFailureSchema = failureVariant("signin_missing", {
    provider: messageFailureProviderSchema,
    /** The native assistant to sign in to, such as "Claude Code"; null for other sources. */
    product: Nullable(Type.String({ minLength: 1, maxLength: 128 })),
    /** The vendor's own sign-in command for a default native login; null for other sources. */
    command: Nullable(Type.String({ minLength: 1, maxLength: 256 })),
});
export const usageLimitFailureSchema = failureVariant("usage_limit", {
    provider: messageFailureProviderSchema,
    resetsAt: resetsAtSchema,
});
export const noAccountAvailableFailureSchema = failureVariant("no_account_available", {
    /** Display name of the routing pool every account of which is spent. */
    poolName: Type.String({ minLength: 1, maxLength: 256 }),
    resetsAt: resetsAtSchema,
});
export const rateLimitedFailureSchema = failureVariant("rate_limited", {
    provider: messageFailureProviderSchema,
});
export const providerUnavailableFailureSchema = failureVariant("provider_unavailable", {
    provider: messageFailureProviderSchema,
});
export const networkFailureSchema = failureVariant("network", {
    provider: messageFailureProviderSchema,
});
export const providerDisabledFailureSchema = failureVariant("provider_disabled", {
    provider: messageFailureProviderSchema,
});
export const contextTooLongFailureSchema = failureVariant("context_too_long", {
    /** The model whose window the conversation no longer fits; clients name it from the catalog. */
    modelId: Type.String({ minLength: 1, maxLength: 256 }),
});
export const internalFailureSchema = failureVariant("internal", {
    /** One sanitized sentence describing what failed. */
    detail: Type.String({ minLength: 1, maxLength: 512 }),
});

/** A kind this client does not know: render `message` with Retry and Ask Chief of Staff. */
export const otherFailureSchema = Type.Composite([
    failureBaseSchema,
    Type.Object({ kind: Type.String({ minLength: 1, maxLength: 64 }) }),
]);

/**
 * Typed failure on an ordinary error service message, protocol 30 or newer, discriminated by
 * `kind`. Clients write the card text from the kind and its fields; the last variant keeps
 * kinds added later readable.
 */
export const messageFailureSchema = Type.Union([
    signinMissingFailureSchema,
    usageLimitFailureSchema,
    noAccountAvailableFailureSchema,
    rateLimitedFailureSchema,
    providerUnavailableFailureSchema,
    networkFailureSchema,
    providerDisabledFailureSchema,
    contextTooLongFailureSchema,
    internalFailureSchema,
    otherFailureSchema,
]);
export type KnownMessageFailure =
    | Static<typeof signinMissingFailureSchema>
    | Static<typeof usageLimitFailureSchema>
    | Static<typeof noAccountAvailableFailureSchema>
    | Static<typeof rateLimitedFailureSchema>
    | Static<typeof providerUnavailableFailureSchema>
    | Static<typeof networkFailureSchema>
    | Static<typeof providerDisabledFailureSchema>
    | Static<typeof contextTooLongFailureSchema>
    | Static<typeof internalFailureSchema>;
/** Narrow on `kind` with {@link isKnownMessageFailure}; anything else is an unknown kind. */
export type MessageFailure = KnownMessageFailure | Static<typeof otherFailureSchema>;

const KNOWN_FAILURE_SCHEMAS: ReadonlyMap<string, TSchema> = new Map<
    KnownMessageFailureKind,
    TSchema
>([
    ["signin_missing", signinMissingFailureSchema],
    ["usage_limit", usageLimitFailureSchema],
    ["no_account_available", noAccountAvailableFailureSchema],
    ["rate_limited", rateLimitedFailureSchema],
    ["provider_unavailable", providerUnavailableFailureSchema],
    ["network", networkFailureSchema],
    ["provider_disabled", providerDisabledFailureSchema],
    ["context_too_long", contextTooLongFailureSchema],
    ["internal", internalFailureSchema],
]);

/**
 * Whether this failure is one of the kinds this client understands, with every field that kind
 * requires. A known kind missing its typed fields stays an unknown-shaped failure, so a client
 * never reads a field such as `resetsAt` that is not there.
 */
export function isKnownMessageFailure(failure: MessageFailure): failure is KnownMessageFailure {
    const schema = KNOWN_FAILURE_SCHEMAS.get(failure.kind);
    return schema !== undefined && Value.Check(schema, failure);
}

/** Service notices that are not failures; unknown kinds render the message text. */
export const knownServiceNoticeKindSchema = Type.Literal("context_reset");
export type KnownServiceNoticeKind = Static<typeof knownServiceNoticeKindSchema>;

/** A typed service notice, protocol 30 or newer. */
export const serviceNoticeSchema = Type.Object({
    kind: Type.String({ minLength: 1, maxLength: 64 }),
});
export type ServiceNotice = Static<typeof serviceNoticeSchema>;

/** An explicit request in a user message for Agent Base to execute one tool before inference. */
export const toolCallRequestBlockSchema = Type.Object(
    {
        arguments: Type.Optional(Type.Record(Type.String(), clientMetadataValueSchema)),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        type: Type.Literal("tool_call_request"),
    },
    { additionalProperties: false },
);

/** An explicit request in a user message for Agent Base to execute one tool before inference. */
export type ToolCallRequestBlock = Static<typeof toolCallRequestBlockSchema>;

/** What is in a message, in order. */
export type MessageBlock =
    | TextBlock
    | ImageBlock
    | ToolCallRequestBlock
    | ReasoningBlock
    | ToolCallBlock
    | ConfigurationBlock
    | CompactionBlock;

/** Plain text. */
export interface TextBlock {
    type: "text";
    text: string;
}

/** An image travelling inline with the message. */
export interface ImageBlock {
    type: "image";
    mimeType: string;
    /** Base64 image bytes, travelling inline. */
    data: string;
}

/** The model's thinking summary, when the provider surfaces one. */
export interface ReasoningBlock {
    type: "reasoning";
    text: string;
}

/** Risk assigned by the automatic permission reviewer. */
export type ToolPermissionRisk = "low" | "medium" | "high" | "critical";

/** How strongly the conversation authorized an automatically reviewed action. */
export type ToolPermissionUserAuthorization = "unknown" | "low" | "medium" | "high";

/** The bounded result of reviewing one tool call. */
export type ToolPermissionReview =
    | {
          outcome: "allowed";
          reason: string;
          risk: ToolPermissionRisk;
          userAuthorization: ToolPermissionUserAuthorization;
      }
    | {
          outcome: "denied";
          reason: string;
          risk: ToolPermissionRisk;
          userAuthorization: ToolPermissionUserAuthorization;
      }
    | {
          outcome: "unproven";
          kind: "timed_out" | "unavailable";
          reason: string;
      };

interface ToolCallBlockBase {
    type: "tool_call";
    /** Happy Agent Base's stable CUID2 identity for this invocation. */
    id: string;
    name: string;
    status: "running" | "completed" | "failed";
    /** Raw tool arguments; absent under `omitToolData`. */
    arguments?: Record<string, unknown>;
    /** Raw tool result; absent under `omitToolData` and until the call finishes. */
    result?: Record<string, unknown>;
    /** A typed rendering of what the call did, when the daemon produced one. */
    presentation?: ToolPresentation;
}

/** A tool call that did not cross the automatic-review boundary. */
export interface UnreviewedToolCallBlock extends ToolCallBlockBase {
    elevated?: never;
    review?: never;
}

/** A reviewed tool call, including whether its eventual execution used temporary Full access. */
export interface ReviewedToolCallBlock extends ToolCallBlockBase {
    elevated: boolean;
    review: ToolPermissionReview;
}

/** One tool invocation. Review metadata is present as one complete, discriminated pair. */
export type ToolCallBlock = UnreviewedToolCallBlock | ReviewedToolCallBlock;

/** What requested a context compaction. */
export const compactionTriggerSchema = Type.Union([
    Type.Literal("manual"),
    Type.Literal("automatic"),
]);
export type CompactionTrigger = Static<typeof compactionTriggerSchema>;

const compactionBlockBaseSchema = Type.Object({
    type: Type.Literal("compaction"),
    trigger: compactionTriggerSchema,
    /** Exact provider-measured input context before compaction, when available. */
    tokensBefore: Nullable(Type.Integer({ minimum: 0 })),
    startedAt: timestampSchema,
});

/** A compaction that has started but has not settled. */
export const runningCompactionBlockSchema = Type.Composite([
    compactionBlockBaseSchema,
    Type.Object({
        status: Type.Literal("running"),
        tokensAfter: Type.Null(),
        failureReason: Type.Null(),
        completedAt: Type.Null(),
    }),
]);
export type RunningCompactionBlock = Static<typeof runningCompactionBlockSchema>;

/** A successfully replaced context, optionally measured by a later inference. */
export const completedCompactionBlockSchema = Type.Composite([
    compactionBlockBaseSchema,
    Type.Object({
        status: Type.Literal("completed"),
        tokensAfter: Nullable(Type.Integer({ minimum: 0 })),
        failureReason: Type.Null(),
        completedAt: timestampSchema,
    }),
]);
export type CompletedCompactionBlock = Static<typeof completedCompactionBlockSchema>;

/** A provider failure, cancellation, or interrupted compaction. */
export const failedCompactionBlockSchema = Type.Composite([
    compactionBlockBaseSchema,
    Type.Object({
        status: Type.Literal("failed"),
        tokensAfter: Type.Null(),
        failureReason: Type.String({ minLength: 1, maxLength: 8_192 }),
        completedAt: timestampSchema,
    }),
]);
export type FailedCompactionBlock = Static<typeof failedCompactionBlockSchema>;

/** One typed context-compaction lifecycle inside a durable service message. */
export const compactionBlockSchema = Type.Union([
    runningCompactionBlockSchema,
    completedCompactionBlockSchema,
    failedCompactionBlockSchema,
]);
export type CompactionBlock = Static<typeof compactionBlockSchema>;

/** Whether a message waits behind the current run or interrupts it. */
export type MessageDelivery = "queue" | "steer";

/** A message, whoever produced it. */
export type Message = UserMessage | AgentMessage | SystemMessage | ServiceMessage;

/** Sent by a person. */
export interface UserMessage {
    id: Cuid2;
    role: "user";
    createdAt: Timestamp;
    content: MessageBlock[];
    metadata: MessageMetadata;
    /** Opaque client-owned JSON, when the sender supplied it. */
    clientMetadata?: ClientMetadata;
    /** Opaque request profile; a change resets the model's private conversation context. */
    profile?: string | null;
    /** `"pending"` until inference takes the message up. */
    status: "pending" | "accepted";
    delivery: MessageDelivery;
    mode: MessageMode;
    /** `null` while pending; assigned at acceptance and the handle for abort. */
    runId: Cuid2 | null;
}

/** Produced by the model: its text, reasoning, and tool calls. */
export interface AgentMessage {
    id: Cuid2;
    role: "agent";
    createdAt: Timestamp;
    content: MessageBlock[];
    metadata: MessageMetadata;
}

/** Content the daemon injected into the model's context, when worth showing. */
export interface SystemMessage {
    id: Cuid2;
    role: "system";
    createdAt: Timestamp;
    content: MessageBlock[];
    metadata: MessageMetadata;
}

/** Operational records the model never saw: compaction, aborts, housekeeping. */
export interface ServiceMessage {
    id: Cuid2;
    role: "service";
    createdAt: Timestamp;
    content: MessageBlock[];
    metadata: MessageMetadata;
    /** Supplementary diagnostics; the original full user-safe text remains in content. */
    error?: MessageError;
    /** Typed failure the client renders from, protocol 30 or newer. */
    failure?: MessageFailure;
    /** Typed non-failure notice, such as a context reset; protocol 30 or newer. */
    notice?: ServiceNotice;
}

/** One durable execution configuration transition, never model input. */
export interface ConfigurationMessage extends Omit<ServiceMessage, "content"> {
    content: [ConfigurationBlock];
}

/** The exact durable message shape used for one compaction attempt. */
export interface CompactionMessage extends Omit<ServiceMessage, "content"> {
    content: [CompactionBlock];
}

/** The run's outcome. */
export type RunStatus = "running" | "completed" | "aborted" | "failed";
/** Why a run ended; status is the outcome, reason is the cause. */
export type RunReason = "completed" | "steering" | "abort" | "error";

/** The work an agent did in response to a message. */
export interface Run {
    id: Cuid2;
    status: RunStatus;
    reason: RunReason | null;
    startedAt: Timestamp;
    endedAt: Timestamp | null;
    usage: UsageBreakdown;
    costUsd: number | null;
}

/** One whole history group, with its messages oldest first. */
export interface HistoryRun extends Run {
    /** Oldest first. */
    messages: Message[];
}

/** `POST /v0/agents/:agentId/send` */
export interface SendMessageRequest {
    /** Optional client-chosen identity. Reusing it returns the existing message. */
    id?: Cuid2;
    /** The message text. Required. */
    text: string;
    /** Opaque JSON to persist and return with this user message. */
    clientMetadata?: ClientMetadata;
    /** Optional rich blocks accompanying the text; image bytes travel inline. */
    content?: MessageBlock[];
    /** Defaults to `"queue"`. On an idle agent the two are identical. */
    delivery?: MessageDelivery;
    /** Opaque context profile. Omitted and `null` both select the default profile. */
    profile?: string | null;
    /** The model selection and permission mode this message runs with. */
    mode: MessageMode;
}

/** `POST /v0/agents/:agentId/send` */
export interface SendMessageResponse {
    message: UserMessage;
    /** The event cursor at send; streaming from it replays everything this causes. */
    cursor: EventCursor;
}

/** `GET /v0/agents/:agentId/messages` query parameters. */
export interface MessageHistoryQuery {
    /** A run ID; return runs older than it. Cannot be combined with `after`. */
    before?: Cuid2;
    /** A message ID; return the messages that came after it. */
    after?: Cuid2;
    /**
     * A lower bound counted in messages, not an upper one: a page always
     * contains whole runs and may overflow well past it.
     */
    limit?: number;
    /** Drop raw data for presented calls, except `agent_spawn` keeps older-client fallback. */
    omitToolData?: boolean;
}

/** `GET /v0/agents/:agentId/messages` */
export const messageHistoryResponseSchema = Type.Object({
    /** The event cursor captured before the history read. */
    cursor: eventCursorSchema,
    hasMore: Type.Boolean(),
    /** Oldest first, whole runs only. */
    runs: Type.Array(Type.Unsafe<HistoryRun>({ type: "object" })),
});

/** `GET /v0/agents/:agentId/messages` */
export type MessageHistoryResponse = Static<typeof messageHistoryResponseSchema>;
