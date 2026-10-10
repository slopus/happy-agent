import { Type } from "@sinclair/typebox";
import { projectEventSchema } from "../../../../happy-agent-modules/sources/projects/ProjectEvent.ts";
import {
    projectRenameInputSchema,
    projectReorderInputSchema,
    projectClearAvatarInputSchema,
    projectSetAvatarInputSchema,
} from "../../../../happy-agent-modules/sources/projects/Project.ts";
import { projectSettingsUpdateInputSchema } from "../../../../happy-agent-modules/sources/projects/ProjectSettings.ts";
import { projectRegisterBodySchema } from "../../../../happy-agent-modules/sources/api/ApiSchemas.ts";

export const projectEditSchemas = {
    ownerProjectEvent: projectEventSchema,
    ownerProjectRename: projectRenameInputSchema,
    ownerProjectReorder: projectReorderInputSchema,
    ownerProjectClearAvatar: projectClearAvatarInputSchema,
    ownerProjectPreparedAvatar: Type.Union(
        projectSetAvatarInputSchema.anyOf.map((schema) =>
            Type.Omit(schema, ["bytes", "contentType"]),
        ),
    ),
    ownerProjectSettingsUpdate: projectSettingsUpdateInputSchema,
    ownerProjectRegistration: Type.Omit(projectRegisterBodySchema, ["mutationId"]),
};
