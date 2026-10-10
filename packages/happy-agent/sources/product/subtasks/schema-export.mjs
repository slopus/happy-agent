// Build-time original TypeBox capture; no alternate native runtime contract.
import * as original from "../../../../happy-agent-modules/sources/subtasks/Subtask.ts";
import { createSubtaskTool } from "../../../../happy-agent-modules/sources/subtasks/tools/create_subtask.ts";
import { archiveSubtaskTool } from "../../../../happy-agent-modules/sources/subtasks/tools/archive_subtask.ts";
export const subtaskTools = [
    createSubtaskTool({ modelDescription: () => "" }, "source-agent", ""),
    archiveSubtaskTool(undefined, "source-agent"),
];
export const subtaskSchemas = {
    ownerSubtaskId: original.subtaskIdSchema,
    ownerSubtaskCreateInput: original.createSubtaskInputSchema,
    ownerSubtaskResult: original.subtaskResultSchema,
    ownerSubtaskStart: original.subtaskStartSchema,
    ownerSubtaskMetadata: original.subtaskMetadataSchema,
    ownerSubtaskWorkspaceMetadata: original.workspaceSubtaskMetadataSchema,
    ownerSubtaskArchivedMetadata: original.archivedMetadataSchema,
    ownerSubtaskRestoredMetadata: original.restoredMetadataSchema,
    ownerSubtaskVersionedMetadata: original.versionedMetadataSchema,
    ownerSubtaskOrderedMetadata: original.orderedSubtaskMetadataSchema,
    ownerSubtaskArchive: original.archiveSubtaskInputSchema,
};
for (const tool of subtaskTools) {
    subtaskSchemas[`ownerTool_${tool.name}`] = tool.parameters;
}
