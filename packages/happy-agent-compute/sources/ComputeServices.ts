import type { Socket } from "node:net";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import { computePermissionsSchema } from "./ComputePermissions.js";
import type { ComputePermissions } from "./ComputePermissions.js";
import type { ManagedNetworkPolicy } from "./network/ManagedNetworkPolicy.js";

const exact = { additionalProperties: false } as const;
export const computeServicePathSchema = Type.String({
    minLength: 1,
    maxLength: 4096,
    pattern:
        "^(?![A-Za-z]:)(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000]+(?:/(?!\\.{1,2}(?:/|$))[^/\\\\\\u0000]+)*$",
});

/** The selected command inputs and the maximum authority of the service for its entire life. */
export const computeServiceSandboxSchema = Type.Object(
    {
        inputs: Type.Array(computeServicePathSchema, { minItems: 1, maxItems: 128 }),
        scratch: Type.Array(computeServicePathSchema, { maxItems: 32 }),
        outbound: Type.Array(
            Type.Object(
                {
                    hostname: Type.String({
                        minLength: 1,
                        maxLength: 253,
                        pattern: "^[A-Za-z0-9.-]+$",
                    }),
                    port: Type.Integer({ minimum: 1, maximum: 65535 }),
                },
                exact,
            ),
            { maxItems: 32 },
        ),
        limits: Type.Object(
            {
                memoryMiB: Type.Integer({ minimum: 128, maximum: 1024 }),
                processes: Type.Integer({ minimum: 1, maximum: 64 }),
            },
            exact,
        ),
    },
    exact,
);
export type ComputeServiceSandbox = Static<typeof computeServiceSandboxSchema>;

/** Durable identity chosen and recorded by the controller before any process is started. */
export const computeServiceExecutionSchema = Type.Object(
    {
        id: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-z0-9]+$" }),
        directory: Type.String({ minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000]+$" }),
    },
    exact,
);
export type ComputeServiceExecution = Static<typeof computeServiceExecutionSchema>;

const networkRule = Type.Object(
    {
        domain: Type.String({ minLength: 1, maxLength: 253 }),
        ports: Type.Optional(
            Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 65535 }),
        ),
    },
    exact,
);
const networkPolicySchema = Type.Unsafe<ManagedNetworkPolicy>(
    Type.Object(
        {
            allowLocalBinding: Type.Optional(Type.Boolean()),
            allowPrivateAddresses: Type.Optional(Type.Boolean()),
            allowedDomains: Type.Optional(Type.Array(networkRule, { maxItems: 1024 })),
            allowedLoopbackPorts: Type.Optional(
                Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 65535 }),
            ),
            deniedDomains: Type.Optional(Type.Array(networkRule, { maxItems: 1024 })),
        },
        exact,
    ),
);

export const computeServiceStartSchema = Type.Object(
    {
        execution: computeServiceExecutionSchema,
        command: Type.String({ minLength: 1, maxLength: 32768, pattern: "^[^\\u0000]+$" }),
        cwd: Type.Union([Type.Literal("."), computeServicePathSchema]),
        port: Type.Integer({ minimum: 1024, maximum: 65535 }),
        tty: Type.Boolean(),
        sandbox: computeServiceSandboxSchema,
        permissions: computePermissionsSchema,
        /** Already resolved user policy. Absence grants no outbound service destinations. */
        networkPolicy: Type.Optional(networkPolicySchema),
    },
    exact,
);
export type ComputeServiceStartOptions = Static<typeof computeServiceStartSchema>;

export interface ComputeServiceOutputPosition {
    stdout: number;
    stderr: number;
}

export interface ComputeServiceOutput {
    stdout: string;
    stderr: string;
    position: ComputeServiceOutputPosition;
    truncated: boolean;
}

export interface ComputeServiceExit {
    exitCode: number | null;
    killed: boolean;
    /** Native setup/exec failure, distinct from the application's own nonzero exit. */
    startupFailed: boolean;
}

/** One real execution; reader positions belong to callers, never to a global consuming cursor. */
export interface ComputeService {
    readonly execution: ComputeServiceExecution;
    readonly processId: string;
    /** Command admission, independent of whether the declared HTTP endpoint is listening. */
    readonly admitted: Promise<boolean>;
    /** Resolves only after native owners, command descendants, and private bridges are gone. */
    readonly completion: Promise<ComputeServiceExit>;
    read(position: ComputeServiceOutputPosition): ComputeServiceOutput;
    write(ctx: Context, permissions: ComputePermissions, chars: string): Promise<boolean>;
    /** Private trusted transport to the one declared HTTP endpoint, never an arbitrary dialer. */
    connect(ctx: Context): Promise<Socket>;
    /** Revoke bridges immediately; return only after confirmed whole-tree teardown. */
    stop(ctx: Context): Promise<ComputeServiceExit>;
}

/** Optional compute capability. Missing capability means refusal, never an ordinary-shell fallback. */
export interface ComputeServices {
    start(ctx: Context, options: ComputeServiceStartOptions): Promise<ComputeService>;
    /** Reconcile a previous execution without rerunning it or signaling a reusable numeric PID. */
    reconcile(ctx: Context, execution: ComputeServiceExecution): Promise<void>;
    dispose(ctx: Context): Promise<void>;
}
