import { Type, type Static } from "@sinclair/typebox";

import { eventIdSchema } from "../events/index.js";

const exact = { additionalProperties: false } as const;

/** How many completed commands remain visible for one agent during this daemon lifetime. */
export const MAX_RETAINED_EXITED_PROCESSES_PER_AGENT = 256;

/** A second bound prevents many short-lived agents from growing one unbounded global history. */
export const MAX_RETAINED_EXITED_PROCESSES = 4_096;

export const computeProcessStatusSchema = Type.Union([
    Type.Literal("exited"),
    Type.Literal("running"),
]);
export type ComputeProcessStatus = Static<typeof computeProcessStatusSchema>;

/** Public lifecycle state for one background command. Output and backend session IDs stay private. */
export const computeProcessSchema = Type.Object(
    {
        agentId: Type.String({ minLength: 1, maxLength: 128 }),
        command: Type.String(),
        endedAt: Type.Union([Type.Null(), Type.Integer({ minimum: 0 })]),
        exitCode: Type.Union([Type.Null(), Type.Integer()]),
        id: Type.String({ minLength: 1, maxLength: 128 }),
        startedAt: Type.Integer({ minimum: 0 }),
        status: computeProcessStatusSchema,
        version: eventIdSchema,
    },
    exact,
);
export type ComputeProcess = Static<typeof computeProcessSchema>;

/** Mutable lifecycle fields carried by process.updated and process.exited. */
export const computeProcessChangesSchema = Type.Partial(
    Type.Pick(computeProcessSchema, ["endedAt", "exitCode", "status"]),
    exact,
);
export type ComputeProcessChanges = Static<typeof computeProcessChangesSchema>;

/**
 * Daemon-lifetime lifecycle events emitted after the module's in-memory transition is visible.
 * Every event names its owner and the post-transition running count so observers never need a
 * reverse process index or a later, race-prone state query.
 *
 * The underscore names are the module vocabulary. ApiModule converts them to the public dotted
 * event vocabulary at its one wire boundary.
 */
export const computeProcessEventSchema = Type.Union([
    Type.Object(
        {
            agentId: Type.String({ minLength: 1, maxLength: 128 }),
            process: computeProcessSchema,
            runningProcesses: Type.Integer({ minimum: 0 }),
            type: Type.Literal("process_started"),
        },
        exact,
    ),
    Type.Object(
        {
            agentId: Type.String({ minLength: 1, maxLength: 128 }),
            changes: computeProcessChangesSchema,
            previousVersion: eventIdSchema,
            processId: Type.String({ minLength: 1, maxLength: 128 }),
            runningProcesses: Type.Integer({ minimum: 0 }),
            type: Type.Literal("process_updated"),
            version: eventIdSchema,
        },
        exact,
    ),
    Type.Object(
        {
            agentId: Type.String({ minLength: 1, maxLength: 128 }),
            changes: computeProcessChangesSchema,
            previousVersion: eventIdSchema,
            processId: Type.String({ minLength: 1, maxLength: 128 }),
            runningProcesses: Type.Integer({ minimum: 0 }),
            type: Type.Literal("process_exited"),
            version: eventIdSchema,
        },
        exact,
    ),
]);
export type ComputeProcessEvent = Static<typeof computeProcessEventSchema>;

const listenerResultSchema = Type.Union([Type.Void(), Type.Promise(Type.Void())]);
export const computeProcessEventListenerSchema = Type.Function(
    [computeProcessEventSchema],
    listenerResultSchema,
);
export type ComputeProcessEventListener = Static<typeof computeProcessEventListenerSchema>;
export type ComputeProcessUnsubscribe = () => void;
