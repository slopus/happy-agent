import { Type, type Static } from "@sinclair/typebox";

import {
    cleanupAgentSchema,
    cleanupItemKindSchema,
    cleanupItemStatusSchema,
} from "./CleanupSearch.js";

const idSchema = Type.String({ minLength: 1, maxLength: 128 });
const folderSchema = Type.String({ minLength: 1 });

/** The one bot, task, subtask, project, or workspace a deletion is asked for. */
export const cleanupDeletionTargetSchema = Type.Object(
    {
        kind: cleanupItemKindSchema,
        /** The bot, task, project, or workspace ID; a subtask's is its agent ID. */
        id: idSchema,
    },
    { additionalProperties: false },
);
export type CleanupDeletionTarget = Static<typeof cleanupDeletionTargetSchema>;

/** One bot, task, subtask, project, or workspace a deletion removes. */
export const cleanupDeletedItemSchema = Type.Object(
    {
        kind: cleanupItemKindSchema,
        id: idSchema,
        name: Type.String(),
        status: cleanupItemStatusSchema,
        running: Type.Boolean(),
        folder: Type.Optional(folderSchema),
    },
    { additionalProperties: false },
);
export type CleanupDeletedItem = Static<typeof cleanupDeletedItemSchema>;

/** A branch a deleted worktree workspace was cut as, and the repository that holds it. */
export const cleanupDeletedBranchSchema = Type.Object(
    { repository: folderSchema, branch: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
);
export type CleanupDeletedBranch = Static<typeof cleanupDeletedBranchSchema>;

/**
 * Everything one deletion removes, computed from the target outwards: the target, every bot,
 * task, subtask, project, and workspace it takes with it, every agent erased with its whole
 * conversation, the folders and branches removed, and the folders deliberately left on disk.
 *
 * `confirmation` names exactly this set. The deletion is refused unless it is given the
 * confirmation of the plan it would carry out at that moment, so nothing that was not previewed
 * is ever removed. Statuses are not part of it: archiving or a run finishing does not change
 * what goes.
 */
export const cleanupDeletionPlanSchema = Type.Object(
    {
        target: cleanupDeletedItemSchema,
        /** The target first, then everything it takes with it. */
        items: Type.Array(cleanupDeletedItemSchema),
        /** Every agent erased, its descendants before it. */
        agents: Type.Array(cleanupAgentSchema),
        folders: Type.Array(folderSchema),
        branches: Type.Array(cleanupDeletedBranchSchema),
        /** Folders a person registered as projects; they are never removed. */
        keptFolders: Type.Array(folderSchema),
        confirmation: Type.String({ minLength: 1 }),
        at: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
export type CleanupDeletionPlan = Static<typeof cleanupDeletionPlanSchema>;

/**
 * The durable deletion work, in the order it runs: agents descendants first, workspaces children
 * first, then tasks, bots, and projects.
 */
export const cleanupDeletionCallSchema = Type.Object(
    {
        agents: Type.Array(idSchema),
        workspaces: Type.Array(idSchema),
        tasks: Type.Array(idSchema),
        bots: Type.Array(idSchema),
        projects: Type.Array(idSchema),
    },
    { additionalProperties: false },
);
export type CleanupDeletionCall = Static<typeof cleanupDeletionCallSchema>;
