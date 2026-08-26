import { Type, type Static } from "@sinclair/typebox";

import {
    durableEntityArgumentsSchema,
    durableProvisionResultSchema,
} from "../durableFunctions/index.js";
import { projectErrorSchema, projectIdSchema } from "./Project.js";

export const PROJECT_PROVISION_FUNCTION = "projects.provision";
export const PROJECT_ARCHIVE_FUNCTION = "projects.archive";
export const PROJECT_CLEANUP_FUNCTION = "projects.cleanup";
export const PROJECT_CLONE_LOCK = "projects.clone";

export const projectDurableArgumentsSchema = durableEntityArgumentsSchema(projectIdSchema);

export const projectProvisionResultSchema = durableProvisionResultSchema(projectErrorSchema);
export const projectArchiveResultSchema = Type.Null();

export type ProjectProvisionResult = Static<typeof projectProvisionResultSchema>;

export const projectOperationId = (operation: "create" | "archive" | "cleanup", id: string) =>
    `project-${operation}.${id}`;

export function projectLockKey(projectId: string): string {
    return `project.${projectId}`;
}
