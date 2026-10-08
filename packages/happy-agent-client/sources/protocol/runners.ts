/** Configured runners: separate machines that hold project folders and run work on them. */
import { Type, type Static } from "@sinclair/typebox";
import { Nullable, resourceVersionSchema, runnerIdSchema, timestampSchema } from "./common.js";

/** What a runner reported when it last connected. */
export const runnerMachineSchema = Type.Object({
    version: Type.String(),
    platform: Type.String(),
    arch: Type.String(),
    hostname: Type.String(),
    /** Places the home project and bot folders. */
    home: Type.String(),
});
export type RunnerMachine = Static<typeof runnerMachineSchema>;

/** One configured runner; tokens and transport addresses never appear. */
export const runnerSchema = Type.Object({
    id: runnerIdSchema,
    name: Type.String({ minLength: 1, maxLength: 128 }),
    /** Whether this is the configured default runner. */
    default: Type.Boolean(),
    status: Type.Union([Type.Literal("connected"), Type.Literal("disconnected")]),
    /** Kept across daemon restarts; `null` before the runner has ever connected. */
    machine: Nullable(runnerMachineSchema),
    /** The runner protocol version in use, or `null` while disconnected. */
    protocol: Nullable(Type.Integer()),
    /** When the status last changed. */
    since: timestampSchema,
    /** A human-readable reason for the last disconnection. */
    reason: Nullable(Type.String()),
});
export type Runner = Static<typeof runnerSchema>;

/** `GET /v0/runners` — in ascending ID order. */
export const runnerListResponseSchema = Type.Object({
    runners: Type.Array(runnerSchema, { maxItems: 32 }),
    version: resourceVersionSchema,
});
export type RunnerListResponse = Static<typeof runnerListResponseSchema>;
