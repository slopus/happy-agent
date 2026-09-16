import { Type, type Static } from "@sinclair/typebox";
import { projectContextSchema } from "./ProjectEvent.js";
import { projectSchema } from "./Project.js";

/** Cleanup owners must positively finish before a managed root may be removed. */
export const projectRemovalBarrierSchema = Type.Function(
    [projectContextSchema, projectSchema],
    Type.Promise(Type.Void()),
);
export type ProjectRemovalBarrier = Static<typeof projectRemovalBarrierSchema>;
