import { cuid2Schema } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { workspaceContextSchema } from "./WorkspaceEvent.js";
import { workspaceSchema } from "./Workspace.js";

/** Close service admission in the archive transaction and return its bounded cleanup identities. */
export const workspaceServiceArchiveListenerSchema = Type.Function(
    [workspaceContextSchema, workspaceSchema],
    Type.Promise(Type.Array(cuid2Schema, { maxItems: 32 })),
);
export type WorkspaceServiceArchiveListener = Static<typeof workspaceServiceArchiveListenerSchema>;

/** A mandatory, awaited filesystem-removal barrier; throwing always retains the directory. */
export const workspaceRemovalBarrierSchema = Type.Function(
    [workspaceContextSchema, workspaceSchema],
    Type.Promise(Type.Void()),
);
export type WorkspaceRemovalBarrier = Static<typeof workspaceRemovalBarrierSchema>;
