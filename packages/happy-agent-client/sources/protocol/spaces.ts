/** Spaces: each person's sidebar, one ordered list of their work in flat sections. */

import { type Static, Type } from "@sinclair/typebox";

import { agentSchema } from "./agents.js";
import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    timestampSchema,
} from "./common.js";

/** What a row shows before its title. */
export const spaceIconSchema = Type.Union([
    Type.Object({ type: Type.Literal("stem_cell") }),
    /** An icon from the desktop's icon library. */
    Type.Object({ slug: Type.String(), type: Type.Literal("library") }),
    /** The content's own picture: a daemon-relative path read with the same bearer token. */
    Type.Object({ type: Type.Literal("image"), url: Type.String() }),
]);
export type SpaceIcon = Static<typeof spaceIconSchema>;

/**
 * What selecting a row opens: nearly always a task; a bot for Happy and other bots; a Surface; or
 * an agent, Prioritizing's own conversation. Clients skip a row whose `kind` they do not know.
 */
export const spaceTargetSchema = Type.Object({
    /** The conversation to show; `null` for a Surface. */
    agentId: Nullable(cuid2Schema),
    /** The task, bot, Surface, or agent. */
    id: cuid2Schema,
    kind: Type.Union([
        Type.Literal("task"),
        Type.Literal("bot"),
        Type.Literal("surface"),
        Type.Literal("agent"),
    ]),
    /** The conversation's workspace; `null` for a Surface. */
    workspaceId: Nullable(cuid2Schema),
});
export type SpaceTarget = Static<typeof spaceTargetSchema>;

export const spaceVisibilitySchema = Type.Union([
    Type.Literal("shown"),
    /** In the Older part of the list. */
    Type.Literal("folded"),
    Type.Literal("hidden"),
]);
export type SpaceVisibility = Static<typeof spaceVisibilitySchema>;

/**
 * One row of the sidebar. Happy is an ordinary row whose target is its bot. A task row's tree comes
 * from the task's agent and workspaces, not from here. Events carry whole rows; keep the copy with
 * the greater `version`.
 */
export const spaceSchema = Type.Object({
    createdAt: timestampSchema,
    /** `null` until one is chosen. */
    icon: Nullable(spaceIconSchema),
    id: cuid2Schema,
    /** Opaque position within its section. */
    orderKey: Type.String(),
    /** `pending` while Prioritizing has not placed new work yet. */
    placement: Type.Union([Type.Literal("pending"), Type.Literal("settled")]),
    sectionId: Nullable(cuid2Schema),
    target: spaceTargetSchema,
    /** `null` while new work has not named itself; clients label it themselves. */
    title: Nullable(Type.String()),
    updatedAt: timestampSchema,
    /** An integer that grows with every change to the row. */
    version: Type.Integer({ minimum: 1 }),
    visibility: spaceVisibilitySchema,
    /** Whether the target's conversation is running now. */
    working: Type.Boolean(),
});
export type Space = Static<typeof spaceSchema>;

/** A flat section of the sidebar. */
export const spaceSectionSchema = Type.Object({
    /** The person closed the whole section. */
    collapsed: Type.Boolean(),
    createdAt: timestampSchema,
    id: cuid2Schema,
    /** Unique within the person's sidebar, ignoring case. */
    name: Type.String(),
    orderKey: Type.String(),
    /** The person opened the "+k more" tail. */
    tailExpanded: Type.Boolean(),
    updatedAt: timestampSchema,
    version: Type.Integer({ minimum: 1 }),
    /** Show only this many rows before "+k more", or all of them when `null`. */
    visibleCount: Nullable(Type.Integer({ minimum: 1 })),
});
export type SpaceSection = Static<typeof spaceSectionSchema>;

/** Where a row was, or went, in a batch. */
export const spaceBatchPositionSchema = Type.Object({
    /** Zero-based, among the rows it was listed with. */
    index: Type.Integer({ minimum: 0 }),
    sectionId: Nullable(Type.String({ minLength: 1, maxLength: 128 })),
    sectionName: Nullable(Type.String()),
    visibility: spaceVisibilitySchema,
});
export type SpaceBatchPosition = Static<typeof spaceBatchPositionSchema>;

export const spaceBatchChangeSchema = Type.Object({
    from: spaceBatchPositionSchema,
    spaceId: cuid2Schema,
    /** The row's title when the batch applied. */
    title: Type.String(),
    to: spaceBatchPositionSchema,
});
export type SpaceBatchChange = Static<typeof spaceBatchChangeSchema>;

/** Prioritizing's changes, applied together at a calm moment. */
export const spaceBatchSchema = Type.Object({
    appliedAt: timestampSchema,
    changes: Type.Array(spaceBatchChangeSchema),
    id: cuid2Schema,
    /** The one line added to Prioritizing's conversation (Happy's, on daemons before proposals). */
    note: Type.String(),
    /** That line's message ID in that conversation, or `null` when it was unavailable. */
    noteMessageId: Nullable(cuid2Schema),
});
export type SpaceBatch = Static<typeof spaceBatchSchema>;

/** `GET /v0/spaces` */
export const spaceListResponseSchema = Type.Object({
    /** Follow `space.*` events from here. */
    cursor: eventCursorSchema,
    sections: Type.Array(spaceSectionSchema),
    spaces: Type.Array(spaceSchema),
});
export type SpaceListResponse = Static<typeof spaceListResponseSchema>;

/** `GET /v0/spaces/batches` — newest first. */
export const spaceBatchListResponseSchema = Type.Object({
    batches: Type.Array(spaceBatchSchema),
});
export type SpaceBatchListResponse = Static<typeof spaceBatchListResponseSchema>;

/** `POST /v0/spaces/stem-cells` — new work, pending under Happy or at the top of a section. */
export const createStemCellRequestSchema = Type.Object({
    /** The retry key: repeating it answers `200` with the existing row and conversation. */
    id: Type.Optional(cuid2Schema),
    /**
     * Optional IDs for the new task, its workspace, and its agent, so the conversation can be
     * shown before the daemon answers. Send them only when health reports
     * `capabilities.stemCellIdentities`; older daemons reject them with `400`.
     */
    taskId: Type.Optional(cuid2Schema),
    workspaceId: Type.Optional(cuid2Schema),
    agentId: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
    sectionId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 128 }))),
});
export type CreateStemCellRequest = Static<typeof createStemCellRequestSchema>;

export const createStemCellResponseSchema = Type.Object({
    agent: agentSchema,
    space: spaceSchema,
});
export type CreateStemCellResponse = Static<typeof createStemCellResponseSchema>;

/**
 * A larger sidebar change Prioritizing proposes as a `sidebar_proposal` artifact. Its version 1 is
 * the sidebar it was drafted from; later versions are the proposed sidebar, which the person may
 * edit, then accept or decline.
 */
export const spaceSidebarProposalSchema = Type.Object({
    artifactId: cuid2Schema,
    /** The proposal artifact's latest version. */
    version: Type.Integer({ minimum: 1 }),
    /** The sidebar version the proposal was drafted from. */
    baseVersion: Type.Integer({ minimum: 1 }),
    status: Type.Union([Type.Literal("open"), Type.Literal("accepted"), Type.Literal("declined")]),
    createdAt: timestampSchema,
    /** When the person accepted or declined it; `null` while open. */
    decidedAt: Nullable(timestampSchema),
    /** The sidebar version accepting it made, or `null`. */
    acceptedVersion: Nullable(Type.Integer({ minimum: 1 })),
    /**
     * New chats the proposal offers, by the space ID reserved for each. Such an ID is no space yet:
     * draw the proposal's row from this entry. Older daemons omit it; treat it as empty.
     */
    newRows: Type.Optional(Type.Array(spaceSidebarProposalNewRowSchema())),
    /** Once accepted, the chats accepting created. Older daemons omit it. */
    started: Type.Optional(Type.Array(Type.Object({ spaceId: cuid2Schema, agentId: cuid2Schema }))),
});
export type SpaceSidebarProposal = Static<typeof spaceSidebarProposalSchema>;

/** One new chat a proposal offers: what its row shows, and the first message accepting sends. */
function spaceSidebarProposalNewRowSchema() {
    return Type.Object({
        id: cuid2Schema,
        title: Type.String({ minLength: 1 }),
        icon: Type.Object({ type: Type.Literal("library"), slug: Type.String() }),
        /** A few words on where the work was seen, or `null`. */
        why: Nullable(Type.String()),
        firstMessage: Type.String({ minLength: 1 }),
    });
}

/** The person's authoritative HTML sidebar and live space identities. */
export const spaceSidebarResponseSchema = Type.Object({
    artifactId: cuid2Schema,
    version: Type.Integer({ minimum: 1 }),
    html: Type.String(),
    spaces: Type.Array(spaceSchema),
    /**
     * Prioritizing's icon for each session by agent ID, whether or not the session is shown.
     * Older daemons omit it; treat a missing map as empty.
     */
    agentIcons: Type.Optional(
        Type.Record(
            Type.String(),
            Type.Object({ slug: Type.String(), type: Type.Literal("library") }),
        ),
    ),
    /**
     * Present while the document still mirrors the classic sidebar, until the person's first
     * write or Prioritizing's next notice. Older daemons omit it; treat a missing flag as false.
     */
    seed: Type.Optional(Type.Literal(true)),
    /**
     * The person's open proposal, when one exists. Daemons without
     * `capabilities.sidebarProposals` omit it.
     */
    proposal: Type.Optional(spaceSidebarProposalSchema),
});
export type SpaceSidebarResponse = Static<typeof spaceSidebarResponseSchema>;

export const updateSpaceSidebarRequestSchema = Type.Object({
    html: Type.String({ maxLength: 131072 }),
    baseVersion: Type.Integer({ minimum: 1 }),
    mutationId: mutationIdSchema,
});
export type UpdateSpaceSidebarRequest = Static<typeof updateSpaceSidebarRequestSchema>;

export const sidebarDiagnosticSchema = Type.Object({
    message: Type.String(),
    offset: Type.Integer({ minimum: 0 }),
});
export type SidebarDiagnostic = Static<typeof sidebarDiagnosticSchema>;

/**
 * A node's stable ID in the sidebar document. Search, Create, and the root are named by their tags,
 * `happy-search`, `happy-create`, and `nav`, which no other node may use.
 */
export const spaceSidebarIdSchema = Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[^\\s\\x00-\\x1f\\x7f]+$",
});
export type SpaceSidebarId = Static<typeof spaceSidebarIdSchema>;

/** Where a foldable row's fold ribbon sits: shown on hover only, or always at the far right. */
export const spaceSidebarFoldRibbonSchema = Type.Union([
    Type.Literal("hover"),
    Type.Literal("always"),
]);
export type SpaceSidebarFoldRibbon = Static<typeof spaceSidebarFoldRibbonSchema>;

/**
 * Where the person pinned a separator: `"top"` keeps everything above it in place, `"bottom"`
 * everything below it. An unpinned separator has no `pin`.
 */
export const spaceSidebarSeparatorPinSchema = Type.Union([
    Type.Literal("top"),
    Type.Literal("bottom"),
]);
export type SpaceSidebarSeparatorPin = Static<typeof spaceSidebarSeparatorPinSchema>;

/** A section heading's title: 1–256 characters, not only whitespace. */
export const spaceSidebarLabelSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "\\S",
});

/** A widget's arbitrary HTML, at most 16 KiB of UTF-8, which is also checked as it applies. */
export const spaceSidebarWidgetHtmlSchema = Type.String({ maxLength: 16 * 1024 });

/**
 * A row (top level, by space ID), or nested under a row or session either a session of that
 * conversation (by agent ID) or an attachment: another of the person's spaces (by space ID), which
 * then stands only there. `expanded` draws what is nested.
 */
export const spaceSidebarSpaceNodeSchema = Type.Recursive((Self) =>
    Type.Object({
        type: Type.Literal("space"),
        id: spaceSidebarIdSchema,
        expanded: Type.Boolean(),
        foldRibbon: Type.Optional(spaceSidebarFoldRibbonSchema),
        children: Type.Array(Self),
    }),
);
export type SpaceSidebarSpaceNode = Static<typeof spaceSidebarSpaceNodeSchema>;

/** One top-level item of the sidebar document, in its flat order. */
export const spaceSidebarItemSchema = Type.Union([
    Type.Object({ type: Type.Literal("search"), id: Type.Literal("happy-search") }),
    Type.Object({ type: Type.Literal("create"), id: Type.Literal("happy-create") }),
    Type.Object({
        type: Type.Literal("section"),
        id: spaceSidebarIdSchema,
        label: spaceSidebarLabelSchema,
        collapsed: Type.Boolean(),
    }),
    Type.Object({
        type: Type.Literal("separator"),
        id: spaceSidebarIdSchema,
        pin: Type.Optional(spaceSidebarSeparatorPinSchema),
    }),
    spaceSidebarSpaceNodeSchema,
    Type.Object({
        type: Type.Literal("widget"),
        id: spaceSidebarIdSchema,
        html: spaceSidebarWidgetHtmlSchema,
    }),
]);
export type SpaceSidebarItem = Static<typeof spaceSidebarItemSchema>;
export type SpaceSidebarNode = SpaceSidebarItem;

/** The sidebar document as a tree: the `nav` root's optional `foldRibbon` and its items. */
export const spaceSidebarDocumentSchema = Type.Object({
    foldRibbon: Type.Optional(spaceSidebarFoldRibbonSchema),
    items: Type.Array(spaceSidebarItemSchema),
});
export type SpaceSidebarDocument = Static<typeof spaceSidebarDocumentSchema>;

/**
 * Where an inserted or moved node goes: immediately after a node and everything nested in it, or
 * first among a row's or session's nested sessions (`null` is the top of the list).
 */
export const spaceSidebarPositionSchema = Type.Union([
    Type.Object({ after: spaceSidebarIdSchema }, { additionalProperties: false }),
    Type.Object({ parent: Nullable(spaceSidebarIdSchema) }, { additionalProperties: false }),
]);
export type SpaceSidebarPosition = Static<typeof spaceSidebarPositionSchema>;

/** A node an `insert` adds. Search and Create are never inserted; sessions are inserted one by one. */
export const spaceSidebarNewNodeSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("space"),
            id: spaceSidebarIdSchema,
            expanded: Type.Optional(Type.Boolean()),
            foldRibbon: Type.Optional(spaceSidebarFoldRibbonSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("section"),
            id: spaceSidebarIdSchema,
            label: spaceSidebarLabelSchema,
            collapsed: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("separator"),
            id: spaceSidebarIdSchema,
            pin: Type.Optional(spaceSidebarSeparatorPinSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("widget"),
            id: spaceSidebarIdSchema,
            html: spaceSidebarWidgetHtmlSchema,
        },
        { additionalProperties: false },
    ),
]);
export type SpaceSidebarNewNode = Static<typeof spaceSidebarNewNodeSchema>;

/**
 * One change to the sidebar document, keyed by node ID. Moving a section moves its block: the
 * heading and every item after it up to the next section or separator. Removing a section removes
 * only its heading. `set` changes `collapsed` and `label` on a section, `pin` on a separator,
 * `expanded` and `foldRibbon` on a row or session, `foldRibbon` on `nav`, and `html` on a widget.
 */
export const spaceSidebarOperationSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("insert"),
            node: spaceSidebarNewNodeSchema,
            to: spaceSidebarPositionSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("move"), id: spaceSidebarIdSchema, to: spaceSidebarPositionSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("remove"), id: spaceSidebarIdSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("set"),
            id: spaceSidebarIdSchema,
            label: Type.Optional(spaceSidebarLabelSchema),
            collapsed: Type.Optional(Type.Boolean()),
            expanded: Type.Optional(Type.Boolean()),
            /** `null` returns to the default. */
            foldRibbon: Type.Optional(Nullable(spaceSidebarFoldRibbonSchema)),
            /** `null` unpins. */
            pin: Type.Optional(Nullable(spaceSidebarSeparatorPinSchema)),
            html: Type.Optional(spaceSidebarWidgetHtmlSchema),
        },
        { additionalProperties: false },
    ),
]);
export type SpaceSidebarOperation = Static<typeof spaceSidebarOperationSchema>;

/**
 * `POST /v0/spaces/sidebar/operations` — the person's batch, made against `baseVersion` and
 * rebased onto the current version. Send it only when health reports
 * `capabilities.sidebarOperations`.
 */
export const spaceSidebarOperationsRequestSchema = Type.Object({
    /** The batch's retry key: a resend with the same request applies nothing again. */
    mutationId: Type.String({ minLength: 1, maxLength: 1024 }),
    baseVersion: Type.Integer({ minimum: 1 }),
    operations: Type.Array(spaceSidebarOperationSchema, { minItems: 1, maxItems: 1000 }),
});
export type SpaceSidebarOperationsRequest = Static<typeof spaceSidebarOperationsRequestSchema>;

export const spaceSidebarOperationsResponseSchema = Type.Object({
    artifactId: cuid2Schema,
    /** The version after the batch; unchanged when it changed nothing. */
    version: Type.Integer({ minimum: 1 }),
    /** The document at `version`, widgets included. */
    html: Type.String(),
    /** What applied: fallen-back anchors resolved, operations that changed nothing left out. */
    operations: Type.Array(spaceSidebarOperationSchema),
});
export type SpaceSidebarOperationsResponse = Static<typeof spaceSidebarOperationsResponseSchema>;

/** Who made a sidebar version: the person, Prioritizing, or the daemon's own lifecycle changes. */
export const spaceSidebarAuthorSchema = Type.Union([
    Type.Literal("person"),
    Type.Literal("prioritizing"),
    Type.Literal("daemon"),
]);
export type SpaceSidebarAuthor = Static<typeof spaceSidebarAuthorSchema>;

/** `GET /v0/spaces/sidebar/proposals/:artifactId` — the proposal and its latest document. */
export const spaceSidebarProposalResponseSchema = Type.Object({
    proposal: spaceSidebarProposalSchema,
    /** The proposal's latest version, widgets included. */
    html: Type.String(),
});
export type SpaceSidebarProposalResponse = Static<typeof spaceSidebarProposalResponseSchema>;

/**
 * `POST /v0/spaces/sidebar/proposals/:artifactId/accept` — apply the proposal to the sidebar as
 * the person's batch. The mutation ID is the retry key.
 */
export const acceptSpaceSidebarProposalRequestSchema = Type.Object({
    mutationId: Type.String({ minLength: 1, maxLength: 1024 }),
});
export type AcceptSpaceSidebarProposalRequest = Static<
    typeof acceptSpaceSidebarProposalRequestSchema
>;

export const acceptSpaceSidebarProposalResponseSchema = Type.Object({
    proposal: spaceSidebarProposalSchema,
    /** The sidebar after the batch, with the operations that applied. */
    sidebar: spaceSidebarOperationsResponseSchema,
    /** The space IDs whose tasks accepting archived, from the proposal's Archive block. */
    archived: Type.Array(cuid2Schema),
    /** The chats accepting created for the proposal's new rows. Older daemons omit it. */
    started: Type.Optional(Type.Array(Type.Object({ spaceId: cuid2Schema, agentId: cuid2Schema }))),
});
export type AcceptSpaceSidebarProposalResponse = Static<
    typeof acceptSpaceSidebarProposalResponseSchema
>;

/** `POST /v0/spaces/sidebar/proposals/:artifactId/decline` — the sidebar stays as it is. */
export const declineSpaceSidebarProposalRequestSchema = Type.Object({
    mutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
});
export type DeclineSpaceSidebarProposalRequest = Static<
    typeof declineSpaceSidebarProposalRequestSchema
>;

export const declineSpaceSidebarProposalResponseSchema = Type.Object({
    proposal: spaceSidebarProposalSchema,
});
export type DeclineSpaceSidebarProposalResponse = Static<
    typeof declineSpaceSidebarProposalResponseSchema
>;

/**
 * `PATCH /v0/spaces/:spaceId` — the person's own change to a row, applied at once. At least one
 * field. Giving `sectionId` moves the row (first in the section unless `afterId` says otherwise);
 * a moved row becomes `shown` unless `visibility` says otherwise.
 */
export const updateSpaceRequestSchema = Type.Object({
    /** The row to follow within the section, or `null` to move first. */
    afterId: Type.Optional(Nullable(cuid2Schema)),
    mutationId: Type.Optional(mutationIdSchema),
    sectionId: Type.Optional(Nullable(cuid2Schema)),
    visibility: Type.Optional(spaceVisibilitySchema),
});
export type UpdateSpaceRequest = Static<typeof updateSpaceRequestSchema>;

/**
 * `PATCH /v0/spaces/:spaceId` with `removed` — takes new work nobody wrote in out of the
 * sidebar and archives its task. Answers `204`, and `409` once its conversation holds a message.
 */
export const removeSpaceRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    removed: Type.Literal(true),
});
export type RemoveSpaceRequest = Static<typeof removeSpaceRequestSchema>;

export const spaceResponseSchema = Type.Object({ space: spaceSchema });
export type SpaceResponse = Static<typeof spaceResponseSchema>;

/** `PATCH /v0/spaces/sections/:sectionId` — the person's own disclosure; at least one flag. */
export const updateSpaceSectionRequestSchema = Type.Object({
    collapsed: Type.Optional(Type.Boolean()),
    mutationId: Type.Optional(mutationIdSchema),
    tailExpanded: Type.Optional(Type.Boolean()),
});
export type UpdateSpaceSectionRequest = Static<typeof updateSpaceSectionRequestSchema>;

export const spaceSectionResponseSchema = Type.Object({ section: spaceSectionSchema });
export type SpaceSectionResponse = Static<typeof spaceSectionResponseSchema>;

/** `POST /v0/spaces/attention` — whether a batch may apply now. */
export const spaceAttentionRequestSchema = Type.Object({
    state: Type.Union([Type.Literal("interacting"), Type.Literal("calm")]),
});
export type SpaceAttentionRequest = Static<typeof spaceAttentionRequestSchema>;

export const spaceAttentionResponseSchema = Type.Object({
    /** The batch this report applied. */
    batch: Nullable(spaceBatchSchema),
});
export type SpaceAttentionResponse = Static<typeof spaceAttentionResponseSchema>;
