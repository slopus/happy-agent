import { workspaceEventSchema } from "../../../../happy-agent-modules/sources/workspaces/WorkspaceEvent.ts";
import {
    workspaceRenameInputSchema,
    workspaceReorderInputSchema,
    workspaceArchiveOptionsSchema,
} from "../../../../happy-agent-modules/sources/workspaces/Workspace.ts";

export const workspaceEditSchemas = {
    ownerWorkspaceEvent: workspaceEventSchema,
    ownerWorkspaceRename: workspaceRenameInputSchema,
    ownerWorkspaceReorder: workspaceReorderInputSchema,
    ownerWorkspaceArchiveOptions: workspaceArchiveOptionsSchema,
};
