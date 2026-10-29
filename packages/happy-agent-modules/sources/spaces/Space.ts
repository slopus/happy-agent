import { cuid2Schema } from "@slopus/happy-agent-base";
import { spaceSidebarOperationSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import { SPACE_ICON_SLUGS } from "./impl/spaceIconSlugs.js";

/** The one person a standalone installation belongs to, as tasks and Surfaces already name it. */
export const SPACE_STANDALONE_OWNER = "standalone";

export const spaceOwnerIdSchema = Type.Union([cuid2Schema, Type.Literal(SPACE_STANDALONE_OWNER)]);
export const spaceTimestampSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const spaceVersionSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const MAX_SPACE_ORDER_KEY_LENGTH = 256;
export const spaceOrderKeySchema = Type.String({
    minLength: 1,
    maxLength: MAX_SPACE_ORDER_KEY_LENGTH,
    pattern: "^[0-9]+$",
});
/** A short human label: nonblank, without control characters. */
export const spaceTextSchema = Type.String({
    minLength: 1,
    maxLength: 256,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});
export const spaceIconSlugSchema = Type.Union(SPACE_ICON_SLUGS.map((slug) => Type.Literal(slug)));

/**
 * Happy is row one, exactly once per person; `focus` is Prioritizing's own conversation and `voice`
 * Voice's, each at most once per person; every other row is an item.
 */
export const spaceRoleSchema = Type.Union([
    Type.Literal("happy"),
    Type.Literal("item"),
    Type.Literal("focus"),
    Type.Literal("voice"),
]);

/** Pending means Prioritizing has not placed the row yet; its position is still its section. */
export const spacePlacementSchema = Type.Union([Type.Literal("pending"), Type.Literal("settled")]);

/** Shown, folded out of view under a collapsed section or parent, or hidden. Hidden is never deletion. */
export const spaceVisibilitySchema = Type.Union([
    Type.Literal("shown"),
    Type.Literal("folded"),
    Type.Literal("hidden"),
]);

/**
 * What the row draws. A stem cell is new work nobody has named yet; a library icon is one slug of
 * the bundled icon set, so only the slug is stored; an image is the content's own picture.
 */
export const spaceIconSchema = Type.Union([
    Type.Object({ type: Type.Literal("stem_cell") }, { additionalProperties: false }),
    Type.Object(
        { type: Type.Literal("library"), slug: spaceIconSlugSchema },
        { additionalProperties: false },
    ),
    Type.Object({ type: Type.Literal("image") }, { additionalProperties: false }),
]);

export const spaceSurfaceTypeSchema = Type.Union([
    Type.Literal("todo"),
    Type.Literal("document"),
    Type.Literal("calendar"),
    Type.Literal("chat"),
    Type.Literal("reference"),
]);

/** The Surfaces a conversation may make, or attach, under its own row. */
export const spaceAttachableSurfaceTypeSchema = Type.Union([
    Type.Literal("todo"),
    Type.Literal("document"),
    Type.Literal("calendar"),
    Type.Literal("chat"),
]);
export type SpaceAttachableSurfaceType = Static<typeof spaceAttachableSurfaceTypeSchema>;

/** One thing a space holds. The first entry is the one a click opens. */
export const spaceRefSchema = Type.Union([
    Type.Object(
        { kind: Type.Literal("task"), taskId: cuid2Schema, agentId: cuid2Schema },
        { additionalProperties: false },
    ),
    Type.Object(
        { kind: Type.Literal("bot"), botId: cuid2Schema, agentId: cuid2Schema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            kind: Type.Literal("surface"),
            surfaceId: cuid2Schema,
            surfaceType: spaceSurfaceTypeSchema,
        },
        { additionalProperties: false },
    ),
    /** A conversation that is neither a task's nor a bot's: Prioritizing's own. */
    Type.Object(
        { kind: Type.Literal("agent"), agentId: cuid2Schema },
        { additionalProperties: false },
    ),
]);

export const spaceRecordSchema = Type.Object(
    {
        id: cuid2Schema,
        ownerUserId: spaceOwnerIdSchema,
        role: spaceRoleSchema,
        /** Absent until Prioritizing chooses one. */
        icon: Type.Optional(spaceIconSchema),
        contents: Type.Array(spaceRefSchema, { maxItems: 32 }),
        /** Absent: directly under Happy, which is where unplaced new work waits. */
        sectionId: Type.Optional(cuid2Schema),
        orderKey: spaceOrderKeySchema,
        placement: spacePlacementSchema,
        visibility: spaceVisibilitySchema,
        /** When the person last moved this row by hand; Prioritizing leaves it there. */
        manualAt: Type.Optional(spaceTimestampSchema),
        /** When Prioritizing was first told about this row's work, so it is told only once. */
        briefedAt: Type.Optional(spaceTimestampSchema),
        version: spaceVersionSchema,
        createdAt: spaceTimestampSchema,
        updatedAt: spaceTimestampSchema,
    },
    { additionalProperties: false },
);

export const spaceSectionRecordSchema = Type.Object(
    {
        id: cuid2Schema,
        ownerUserId: spaceOwnerIdSchema,
        name: spaceTextSchema,
        /** Partial collapse: only the first rows show, the rest wait behind "+k more". */
        visibleCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        collapsed: Type.Boolean(),
        tailExpanded: Type.Boolean(),
        orderKey: spaceOrderKeySchema,
        version: spaceVersionSchema,
        createdAt: spaceTimestampSchema,
        updatedAt: spaceTimestampSchema,
    },
    { additionalProperties: false },
);

/**
 * One reorganisation Prioritizing wants and has not been allowed to make yet. Changes wait until
 * the person is calm, then apply together as one batch.
 */
export const spacePendingChangeSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("place"),
            spaceId: cuid2Schema,
            /** `null` puts the row directly under Happy. */
            sectionId: Type.Union([cuid2Schema, Type.Null()]),
            /** After this row; `null` or absent puts it first. */
            afterId: Type.Optional(Type.Union([cuid2Schema, Type.Null()])),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("visibility"),
            spaceId: cuid2Schema,
            visibility: spaceVisibilitySchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            type: Type.Literal("section"),
            sectionId: cuid2Schema,
            create: Type.Boolean(),
            name: Type.Optional(spaceTextSchema),
            visibleCount: Type.Optional(
                Type.Union([Type.Integer({ minimum: 1, maximum: 100 }), Type.Null()]),
            ),
            /** After this section; `null` puts it first; absent keeps its place (last if new). */
            afterSectionId: Type.Optional(Type.Union([cuid2Schema, Type.Null()])),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("remove_section"), sectionId: cuid2Schema },
        { additionalProperties: false },
    ),
]);

const spacePositionSchema = Type.Object(
    {
        sectionId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
        sectionName: Type.Union([Type.String(), Type.Null()]),
        /** The item's index among its siblings. */
        index: Type.Integer({ minimum: 0 }),
        visibility: spaceVisibilitySchema,
        placement: spacePlacementSchema,
    },
    { additionalProperties: false },
);

export const spaceBatchChangeSchema = Type.Object(
    {
        spaceId: cuid2Schema,
        title: Type.String(),
        from: spacePositionSchema,
        to: spacePositionSchema,
    },
    { additionalProperties: false },
);

export const spaceBatchSectionChangeSchema = Type.Object(
    {
        sectionId: Type.String({ minLength: 1, maxLength: 128 }),
        name: Type.String(),
        change: Type.Union([
            Type.Literal("created"),
            Type.Literal("updated"),
            Type.Literal("removed"),
        ]),
    },
    { additionalProperties: false },
);

/** One applied reorganisation: the note shown in Happy's chat and every row that moved. */
export const spaceBatchSchema = Type.Object(
    {
        id: cuid2Schema,
        ownerUserId: spaceOwnerIdSchema,
        note: Type.String({ minLength: 1, maxLength: 1_000 }),
        noteMessageId: Type.Optional(cuid2Schema),
        changes: Type.Array(spaceBatchChangeSchema),
        sections: Type.Array(spaceBatchSectionChangeSchema),
        appliedAt: spaceTimestampSchema,
    },
    { additionalProperties: false },
);

/** Who last set one aspect of a sidebar node. The daemon's own lifecycle changes record nobody. */
export const sidebarAuthorSchema = Type.Union([
    Type.Literal("person"),
    Type.Literal("prioritizing"),
]);
export type SidebarAuthor = Static<typeof sidebarAuthorSchema>;

/**
 * Who last set each aspect of one node: its place (inserted, moved, removed, or regrouped under
 * another heading), its fold, its section label, its fold ribbon, and a widget's content.
 */
export const sidebarAuthorshipSchema = Type.Object(
    {
        place: Type.Optional(sidebarAuthorSchema),
        fold: Type.Optional(sidebarAuthorSchema),
        label: Type.Optional(sidebarAuthorSchema),
        foldRibbon: Type.Optional(sidebarAuthorSchema),
        html: Type.Optional(sidebarAuthorSchema),
    },
    { additionalProperties: false },
);
export type SidebarAuthorship = Static<typeof sidebarAuthorshipSchema>;
export type SidebarAspect = keyof SidebarAuthorship;

/**
 * A new chat a proposal offers, by the space ID reserved for it: what its row shows, and the first
 * message accepting sends. The first message lives only here, never in the document.
 */
export const sidebarProposalNewRowSchema = Type.Object(
    {
        id: cuid2Schema,
        title: Type.String({ minLength: 1, maxLength: 80 }),
        icon: spaceIconSlugSchema,
        why: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        firstMessage: Type.String({ minLength: 1, maxLength: 2_000 }),
    },
    { additionalProperties: false },
);
export type SidebarProposalNewRow = Static<typeof sidebarProposalNewRowSchema>;

/** A chat accepting a proposal created for one of its new rows. */
export const sidebarProposalStartedSchema = Type.Object(
    { spaceId: cuid2Schema, agentId: cuid2Schema },
    { additionalProperties: false },
);

/**
 * One sidebar proposal: a `sidebar_proposal` artifact whose version 1 is the sidebar it was drafted
 * from. `authorship` records what the person set in it, so Prioritizing's revisions keep it.
 */
export const sidebarProposalRecordSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        baseVersion: spaceVersionSchema,
        status: Type.Union([
            Type.Literal("open"),
            Type.Literal("accepted"),
            Type.Literal("declined"),
        ]),
        createdAt: spaceTimestampSchema,
        decidedAt: Type.Optional(spaceTimestampSchema),
        acceptedVersion: Type.Optional(spaceVersionSchema),
        /** The mutation that decided it, so a retried decision answers as the first did. */
        decisionMutationId: Type.Optional(Type.String({ minLength: 1, maxLength: 1100 })),
        archived: Type.Optional(Type.Array(cuid2Schema, { maxItems: 1000 })),
        newRows: Type.Optional(Type.Array(sidebarProposalNewRowSchema, { maxItems: 16 })),
        started: Type.Optional(Type.Array(sidebarProposalStartedSchema, { maxItems: 16 })),
        authorship: Type.Optional(
            Type.Record(Type.String({ minLength: 1, maxLength: 128 }), sidebarAuthorshipSchema, {
                maxProperties: 2000,
            }),
        ),
    },
    { additionalProperties: false },
);
export type SidebarProposalRecord = Static<typeof sidebarProposalRecordSchema>;

/** A proposal as clients see it. */
export const sidebarProposalSchema = Type.Object(
    {
        artifactId: cuid2Schema,
        version: spaceVersionSchema,
        baseVersion: spaceVersionSchema,
        status: sidebarProposalRecordSchema.properties.status,
        createdAt: spaceTimestampSchema,
        decidedAt: Type.Union([spaceTimestampSchema, Type.Null()]),
        acceptedVersion: Type.Union([spaceVersionSchema, Type.Null()]),
        newRows: Type.Array(
            Type.Object(
                {
                    id: cuid2Schema,
                    title: sidebarProposalNewRowSchema.properties.title,
                    icon: Type.Object(
                        { type: Type.Literal("library"), slug: spaceIconSlugSchema },
                        { additionalProperties: false },
                    ),
                    why: Type.Union([Type.String({ minLength: 1, maxLength: 160 }), Type.Null()]),
                    firstMessage: sidebarProposalNewRowSchema.properties.firstMessage,
                },
                { additionalProperties: false },
            ),
        ),
        started: Type.Array(sidebarProposalStartedSchema),
    },
    { additionalProperties: false },
);
export type SidebarProposal = Static<typeof sidebarProposalSchema>;

/** Each person's sidebar bookkeeping. */
export const spaceOwnerStateSchema = Type.Object(
    {
        ownerUserId: spaceOwnerIdSchema,
        sidebarArtifactId: Type.Optional(cuid2Schema),
        /**
         * Authorship by node ID, most recently set last. Entries outlive removed nodes, so what the
         * person took out stays theirs; the daemon's own removals take theirs along.
         */
        sidebarAuthorship: Type.Optional(
            Type.Record(Type.String({ minLength: 1, maxLength: 128 }), sidebarAuthorshipSchema, {
                maxProperties: 2000,
            }),
        ),
        sidebarPlacedIds: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 1000 }),
        ),
        /**
         * Surfaces someone attached under a row: their rows stay while the Surface holds no
         * content, until the person leaves it.
         */
        attachedSurfaceIds: Type.Optional(Type.Array(cuid2Schema, { maxItems: 1000 })),
        /** The document is still the classic-sidebar seed nobody has written to yet. */
        sidebarSeed: Type.Optional(Type.Literal(true)),
        /** Icons Prioritizing chose for sessions under the person's rows, by agent ID. */
        agentIcons: Type.Optional(
            Type.Record(cuid2Schema, spaceIconSlugSchema, { maxProperties: 1000 }),
        ),
        /**
         * Prioritizing's proposals waiting for calm, each already turned into operations against
         * the document it read. `baseVersion` is the artifact version current when it was queued.
         */
        sidebarPending: Type.Optional(
            Type.Array(
                Type.Object(
                    {
                        operations: Type.Array(spaceSidebarOperationSchema, { maxItems: 4000 }),
                        baseVersion: spaceVersionSchema,
                        operationId: Type.String({ minLength: 1, maxLength: 256 }),
                        title: Type.Optional(spaceTextSchema),
                        background: Type.Optional(
                            Type.Union([
                                Type.String({
                                    pattern:
                                        "^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$",
                                }),
                                Type.Null(),
                            ]),
                        ),
                    },
                    { additionalProperties: false },
                ),
                { maxItems: 32 },
            ),
        ),
        sidebarBrief: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 })),
        /** Notices already told, kept until a run of Prioritizing ends well. */
        sidebarBriefSent: Type.Optional(
            Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 32 }),
        ),
        /** When an event first asked to wake Prioritizing since its last brief. */
        sidebarWakeAt: Type.Optional(spaceTimestampSchema),
        prioritizingAgentId: Type.Optional(cuid2Schema),
        /**
         * The person pressed Discover in onboarding: Prioritizing may read that assistant's own
         * history, and only the places Happy disclosed.
         */
        discovery: Type.Optional(
            Type.Object(
                { assistant: Type.Union([Type.Literal("codex"), Type.Literal("claude")]) },
                { additionalProperties: false },
            ),
        ),
        /** Happy messaged Prioritizing; when that turn ends, Happy hears what came of it. */
        happyAsked: Type.Optional(Type.Literal(true)),
        /** The revision of Prioritizing's instructions it was last told about. */
        prioritizingRevision: Type.Optional(Type.Integer({ minimum: 0 })),
        /** Prioritizing's proposals, newest last; at most one is open. */
        sidebarProposals: Type.Optional(Type.Array(sidebarProposalRecordSchema, { maxItems: 20 })),
        prioritizingGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
        /**
         * The person asked for something to happen now — a move in their own words, or a new sidebar to organise —
         * so the queued changes apply as soon as Prioritizing finishes, without the consent limits.
         */
        applyRequestedAt: Type.Optional(spaceTimestampSchema),
    },
    { additionalProperties: false },
);

/**
 * One committed batch of sidebar operations, kept so a retry with the same mutation ID answers
 * with the first result instead of applying again.
 */
export const sidebarMutationSchema = Type.Object(
    {
        ownerUserId: spaceOwnerIdSchema,
        mutationId: Type.String({ minLength: 1, maxLength: 1100 }),
        /** The document version the batch left. */
        version: spaceVersionSchema,
        author: Type.Union([sidebarAuthorSchema, Type.Literal("daemon")]),
        /** What the request was, so the same ID with another request is a conflict. */
        digest: Type.String({ minLength: 64, maxLength: 64 }),
        operations: Type.Array(spaceSidebarOperationSchema, { maxItems: 4000 }),
        appliedAt: spaceTimestampSchema,
    },
    { additionalProperties: false },
);
export type SidebarMutation = Static<typeof sidebarMutationSchema>;

export type SpaceOwnerId = Static<typeof spaceOwnerIdSchema>;
export type SpaceRole = Static<typeof spaceRoleSchema>;
export type SpacePlacement = Static<typeof spacePlacementSchema>;
export type SpaceVisibility = Static<typeof spaceVisibilitySchema>;
export type SpaceIcon = Static<typeof spaceIconSchema>;
export type SpaceIconSlug = Static<typeof spaceIconSlugSchema>;
export type SpaceRef = Static<typeof spaceRefSchema>;
export type SpaceRecord = Static<typeof spaceRecordSchema>;
export type SpaceSectionRecord = Static<typeof spaceSectionRecordSchema>;
export type SpacePendingChange = Static<typeof spacePendingChangeSchema>;
export type SpaceBatch = Static<typeof spaceBatchSchema>;
export type SpaceBatchChange = Static<typeof spaceBatchChangeSchema>;
export type SpaceBatchSectionChange = Static<typeof spaceBatchSectionChangeSchema>;
export type SpaceOwnerState = Static<typeof spaceOwnerStateSchema>;

/** What a person's sidebar holds right now. */
export interface SpaceSnapshot {
    readonly spaces: readonly SpaceRecord[];
    readonly sections: readonly SpaceSectionRecord[];
}

/** What a click on a row opens. */
export interface SpaceTarget {
    readonly kind: "task" | "bot" | "surface" | "agent";
    readonly id: string;
    readonly agentId?: string;
    readonly workspaceId?: string;
}

/** A row's content resolved for display and for Prioritizing's judgement. */
export interface SpaceDescription {
    readonly title: string;
    /** False while the content still carries a placeholder name it will replace itself. */
    readonly named: boolean;
    readonly target: SpaceTarget | undefined;
    readonly archived: boolean;
    readonly working: boolean;
    readonly lastActivityAt: number | undefined;
    /** A daemon-relative URL of the content's own picture, when it has one. */
    readonly imageUrl: string | undefined;
}

export class SpaceNotFoundError extends Error {
    constructor(message = "The space was not found.") {
        super(message);
        this.name = "SpaceNotFoundError";
    }
}

export class SpaceInputError extends Error {
    constructor(message = "The space request is invalid.") {
        super(message);
        this.name = "SpaceInputError";
    }
}

export class SpaceConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SpaceConflictError";
    }
}

/** One person's stored sidebar state cannot be read; Spaces is unavailable for that person only. */
export class SpaceStorageError extends Error {
    constructor(readonly ownerUserId: string | undefined) {
        super(
            "Your sidebar's saved state could not be read. It may come from a newer version of Happy Agent; update Happy Agent to use the sidebar again.",
        );
        this.name = "SpaceStorageError";
    }
}
