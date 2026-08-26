import { Type, type Static } from "@sinclair/typebox";

import type { ProjectCreator } from "../git/types.js";

import type { ProjectRemoteSource } from "./Project.js";

/** The Git identity and installation that own a managed clone. */
export const projectCreatorProfileSchema = Type.Object(
    {
        email: Type.String({ minLength: 1, maxLength: 320 }),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        parentInstanceId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);

export type ProjectCreatorProfile = Static<typeof projectCreatorProfileSchema>;

/** A folder the catalog is asked to adopt as a project without starting a session in it. */
export interface RegisterProjectRequest {
    readonly path: string;
    readonly projectId?: string;
}

/** A project whose folder does not exist yet, because its repository still has to be cloned. */
export interface CreateRemoteProjectRequest {
    readonly name: string;
    readonly projectId?: string;
    readonly secret?: { readonly kind: "github" };
    readonly source: ProjectRemoteSource;
}

/** Who asked for a managed project or workspace, and with which credential. */
export interface ProjectCreatorOptions {
    readonly createdBy?: ProjectCreator;
    readonly githubToken?: string;
}
