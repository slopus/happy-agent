/** Installed global skills; detect support through the catalog endpoint, not a protocol bump. */
import { Type, type Static } from "@sinclair/typebox";

import {
    cuid2Schema,
    eventCursorSchema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";

/** A normalized relative path, never an arbitrary host-file address. */
export const skillRelativePathSchema = Type.String({
    minLength: 1,
    maxLength: 4_096,
    pattern: "^(?![A-Za-z]:)(?!.*(?:^|/)\\.{1,2}(?:/|$))[^/\\\\\\u0000]+(?:/[^/\\\\\\u0000]+)*$",
});
export type SkillRelativePath = Static<typeof skillRelativePathSchema>;

export const globalSkillSchema = Type.Object({
    id: cuid2Schema,
    path: skillRelativePathSchema,
    // Invalid documents fall back to the directory basename, which need not be a valid skill name.
    name: Type.String({ minLength: 1, maxLength: 4_096 }),
    description: Type.String({ maxLength: 1_024 }),
    enabled: Type.Boolean(),
    status: Type.Union([
        Type.Literal("ready"),
        Type.Literal("invalid"),
        Type.Literal("unreadable"),
    ]),
    error: Nullable(Type.String()),
    version: resourceVersionSchema,
    updatedAt: timestampSchema,
});
export type GlobalSkill = Static<typeof globalSkillSchema>;

export const skillPageCursorSchema = Type.String({ minLength: 1, maxLength: 512 });
export const skillPageQuerySchema = Type.Object({
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    pageCursor: Type.Optional(skillPageCursorSchema),
});
export type SkillPageQuery = Static<typeof skillPageQuerySchema>;

export const globalSkillListResponseSchema = Type.Object({
    skills: Type.Array(globalSkillSchema, { maxItems: 100 }),
    nextPageCursor: Nullable(skillPageCursorSchema),
    /** Journal position captured before reading, distinct from the pagination cursor. */
    cursor: eventCursorSchema,
});
export type GlobalSkillListResponse = Static<typeof globalSkillListResponseSchema>;

export const globalSkillResponseSchema = Type.Object({ skill: globalSkillSchema });
export type GlobalSkillResponse = Static<typeof globalSkillResponseSchema>;

export const globalSkillDocumentResponseSchema = Type.Object({
    skill: globalSkillSchema,
    content: Nullable(Type.String({ maxLength: 256 * 1024 })),
    instructions: Nullable(Type.String({ maxLength: 256 * 1024 })),
});
export type GlobalSkillDocumentResponse = Static<typeof globalSkillDocumentResponseSchema>;

export const updateGlobalSkillRequestSchema = Type.Object({
    enabled: Type.Boolean(),
    mutationId: Type.Optional(mutationIdSchema),
});
export type UpdateGlobalSkillRequest = Static<typeof updateGlobalSkillRequestSchema>;

export const globalSkillFileSchema = Type.Object({
    path: skillRelativePathSchema,
    size: Type.Integer({ minimum: 0 }),
    modifiedAt: timestampSchema,
});
export type GlobalSkillFile = Static<typeof globalSkillFileSchema>;

export const globalSkillFileListResponseSchema = Type.Object({
    files: Type.Array(globalSkillFileSchema, { maxItems: 100 }),
    nextPageCursor: Nullable(skillPageCursorSchema),
    version: resourceVersionSchema,
});
export type GlobalSkillFileListResponse = Static<typeof globalSkillFileListResponseSchema>;

/** Compact invalidation; disabled and removed records may be named here too. */
export const skillsUpdatedPayloadSchema = Type.Object({
    skillIds: Nullable(Type.Array(cuid2Schema, { maxItems: 100 })),
    paths: Nullable(Type.Array(skillRelativePathSchema, { maxItems: 100 })),
    mutationId: Type.Optional(mutationIdSchema),
});
export type SkillsUpdatedPayload = Static<typeof skillsUpdatedPayloadSchema>;
