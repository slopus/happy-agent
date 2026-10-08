/**
 * The small values every chapter of the API shares.
 *
 * Shared wire values are declared as TypeBox schemas with their TypeScript
 * types derived through `Static`, so one declaration serves as the compile-time
 * contract and as the schema a consumer that wants runtime validation checks
 * against. The client itself does not validate responses; see
 * `HappyAgentClient`.
 *
 * Objects are deliberately not `additionalProperties: false`: the
 * specification says its shapes grow, and a client must keep working when a
 * newer daemon adds a field it has never heard of.
 */

import { type Static, type TSchema, Type } from "@sinclair/typebox";

/** A value that may be absent by being explicitly `null`. */
export function Nullable<T extends TSchema>(schema: T) {
    return Type.Union([schema, Type.Null()]);
}

/** A CUID2 identifier: opaque, URL-safe, and never ordered by the client. */
export const cuid2Schema = Type.String();
export type Cuid2 = Static<typeof cuid2Schema>;

/** A UUIDv7 position in the event journal; greater means newer. */
export const eventCursorSchema = Type.String();
export type EventCursor = Static<typeof eventCursorSchema>;

/** A UUIDv7 resource version, minted at the moment the resource changed. */
export const resourceVersionSchema = Type.String();
export type ResourceVersion = Static<typeof resourceVersionSchema>;

/** Unix epoch milliseconds. */
export const timestampSchema = Type.Integer();
export type Timestamp = Static<typeof timestampSchema>;

/** The opaque echo a client attaches to a mutation to recognize its own change. */
export const mutationIdSchema = Type.String();
export type MutationId = Static<typeof mutationIdSchema>;

/**
 * An effort level, named by the config catalog (`"medium"`, `"xhigh"`, …).
 *
 * The catalog is data the daemon serves rather than a fixed set, so the values
 * a model allows are read from its definition in `GET /v0/config`.
 */
export const effortSchema = Type.String();
export type Effort = Static<typeof effortSchema>;

/** A service tier, named by the config catalog. */
export const serviceTierSchema = Type.String();
export type ServiceTier = Static<typeof serviceTierSchema>;

/** How much a run is allowed to do without asking. */
export const permissionModeSchema = Type.Union([
    Type.Literal("read_only"),
    Type.Literal("workspace_write"),
    Type.Literal("auto"),
    Type.Literal("full_access"),
]);
export type PermissionMode = Static<typeof permissionModeSchema>;

/** The model selection and permission mode a message runs with. */
export const messageModeSchema = Type.Object({
    effort: effortSchema,
    modelId: Type.String(),
    permissionMode: permissionModeSchema,
    providerId: Type.String(),
    /** `null` means the provider's default tier. */
    serviceTier: Nullable(serviceTierSchema),
});
export type MessageMode = Static<typeof messageModeSchema>;

/** A folder on this machine. */
export const hostComputeSchema = Type.Object({
    path: Type.String(),
    type: Type.Literal("host"),
});
export type HostCompute = Static<typeof hostComputeSchema>;

/** A configured runner's ID; the same rule as remote connection IDs. */
export const runnerIdSchema = Type.String({
    pattern: "^[a-z][a-z0-9_-]{0,63}$",
});
export type RunnerId = Static<typeof runnerIdSchema>;

/** A container the daemon runs work in. */
export const dockerComputeSchema = Type.Object({
    image: Type.String(),
    /** The workspace folder, mounted at the same place in the container. Absent on older daemons. */
    path: Type.Optional(Type.String()),
    /** The runner holding the folder; absent when it is on the daemon's machine. */
    runnerId: Type.Optional(runnerIdSchema),
    type: Type.Literal("docker"),
});
export type DockerCompute = Static<typeof dockerComputeSchema>;

/** A folder on a runner, with `path` in the runner's own filesystem. */
export const runnerComputeSchema = Type.Object({
    /** `null` for the home project until its runner has first connected. */
    path: Nullable(Type.String()),
    runnerId: runnerIdSchema,
    type: Type.Literal("runner"),
});
export type RunnerCompute = Static<typeof runnerComputeSchema>;

/** Where files live and where work on them executes. */
export const computeSchema = Type.Union([
    hostComputeSchema,
    dockerComputeSchema,
    runnerComputeSchema,
]);
export type Compute = Static<typeof computeSchema>;

/** A compute chosen before anything runs, so it carries no addressing yet. */
export const computeSelectionSchema = Type.Union([
    Type.Object({ type: Type.Literal("host") }),
    Type.Object({
        image: Type.String(),
        /** Equal to the project's runner when present. */
        runnerId: Type.Optional(runnerIdSchema),
        type: Type.Literal("docker"),
    }),
    Type.Object({ runnerId: runnerIdSchema, type: Type.Literal("runner") }),
]);
export type ComputeSelection = Static<typeof computeSelectionSchema>;

/** How far a project or workspace got through its setup. */
export const initializationStateSchema = Type.Object({
    /** How many setup runs have been attempted. */
    attempt: Type.Integer(),
    /** A human-readable message when setup failed. */
    error: Nullable(Type.String()),
    status: Type.Union([
        Type.Literal("initializing"),
        Type.Literal("ready"),
        Type.Literal("failed"),
    ]),
});
export type InitializationState = Static<typeof initializationStateSchema>;

/** Where a repository stands, as reported on projects, workspaces, and git state. */
export const gitSummarySchema = Type.Object({
    ahead: Type.Integer(),
    behind: Type.Integer(),
    /** The current branch; absent or `null` on a detached HEAD. */
    branch: Type.Optional(Nullable(Type.String())),
    detached: Type.Boolean(),
    head: Type.String(),
    upstream: Nullable(Type.String()),
});
export type GitSummary = Static<typeof gitSummarySchema>;
