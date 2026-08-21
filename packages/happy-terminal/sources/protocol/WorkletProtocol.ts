import { Type, type Static } from "@sinclair/typebox";

import type { EventId } from "./EventId.js";

/**
 * What a worklet is doing right now.
 *
 * `starting` covers the window a freshly launched worklet has to register its tools and report
 * ready. `running` means it is up and its tools are callable. `asleep` is reserved for a worklet
 * that has nothing outstanding and has been parked; nothing puts a worklet to sleep yet.
 */
export const workletStateSchema = Type.Union([
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("asleep"),
    Type.Literal("stopped"),
    Type.Literal("failed"),
]);

export type WorkletState = Static<typeof workletStateSchema>;

export const workletToolSchema = Type.Object(
    {
        name: Type.String({ minLength: 1 }),
        description: Type.String(),
    },
    { additionalProperties: false },
);

export type WorkletTool = Static<typeof workletToolSchema>;

/** A worklet always writes only inside its own durable `Data` folder. */
export const workletDiskPermissionSchema = Type.Literal("none", {
    description: "Nothing outside the worklet's own Data folder is writable.",
});

export type WorkletDiskPermission = Static<typeof workletDiskPermissionSchema>;

/**
 * Where a worklet may reach on the network. A scoped worklet's traffic runs through Happy Terminal's managed
 * proxy, which allows exactly the declared hosts and refuses the rest.
 */
export const workletNetworkPermissionSchema = Type.Union([
    Type.Literal("none", { description: "No network access at all." }),
    Type.Object(
        {
            hosts: Type.Array(Type.String({ minLength: 1 }), {
                description:
                    'Hosts the worklet may reach, such as "api.github.com" or "api.github.com:8080". A leading "*." matches subdomains, and port 443 is assumed when none is given.',
                maxItems: 64,
                minItems: 1,
            }),
        },
        { additionalProperties: false },
    ),
]);

export type WorkletNetworkPermission = Static<typeof workletNetworkPermissionSchema>;

/** Everything a worklet may touch beyond its own folder and the socket it reaches Happy Terminal on. */
export const workletPermissionsSchema = Type.Object(
    {
        disk: workletDiskPermissionSchema,
        network: workletNetworkPermissionSchema,
    },
    { additionalProperties: false },
);

export type WorkletPermissions = Static<typeof workletPermissionsSchema>;

/**
 * One imported version, carrying the manifest it was imported with.
 *
 * What a worklet says about itself and what it is allowed to do are properties of its code, so
 * they are recorded per version. Reverting therefore restores the older version's permissions
 * along with its source, and never leaves a newer grant in force.
 */
export const workletVersionSchema = Type.Object(
    {
        version: Type.Integer({ minimum: 1 }),
        changeDescription: Type.String({ description: "What changed in this import." }),
        createdAt: Type.Number(),
        description: Type.String({ description: "What this version of the worklet does." }),
        permissions: workletPermissionsSchema,
    },
    { additionalProperties: false },
);

export type WorkletVersion = Static<typeof workletVersionSchema>;

/**
 * A worklet is background compute Happy Terminal keeps running: TypeScript imported as a source folder,
 * versioned like an applet, writing only into its own `Data` folder, and declaring tools any
 * agent can call.
 */
export const workletSchema = Type.Object(
    {
        name: Type.String({ description: "Human-readable kebab-case worklet name." }),
        description: Type.String({ description: "What the worklet does." }),
        /** What the current version's manifest asks for, and what Happy Terminal is enforcing right now. */
        permissions: workletPermissionsSchema,
        iconThumbhash: Type.String({
            description: "ThumbHash for the worklet's persisted 512 by 512 icon.",
            minLength: 1,
        }),
        iconUrl: Type.String({
            description: "Happy Terminal HTTP path that serves the worklet's persisted icon.",
            minLength: 1,
        }),
        authorSessionId: Type.String({
            description: "The session of the agent that installed the worklet.",
        }),
        sourceDescription: Type.Optional(
            Type.String({
                description: "Where the sources live, such as the project and folder.",
            }),
        ),
        currentVersion: Type.Integer({ minimum: 1 }),
        versions: Type.Array(workletVersionSchema),
        createdAt: Type.Number(),
        updatedAt: Type.Number(),
        /** The folder the worklet writes into. It survives every version change. */
        dataDirectory: Type.String({ minLength: 1 }),
        state: workletStateSchema,
        /** The worklet's own words about itself, shown in the interface. */
        status: Type.Optional(Type.String()),
        /** Why the worklet is not running, when it failed or stopped. */
        failure: Type.Optional(Type.String()),
        tools: Type.Array(workletToolSchema),
    },
    { additionalProperties: false },
);

export type Worklet = Static<typeof workletSchema>;

/**
 * An install names a folder and an icon, and nothing else.
 *
 * The worklet's name, what it does, why it exists, and what it is allowed to touch all come from
 * the `worklet.json` at the root of that folder, so the code and its declared powers arrive
 * together and no caller can describe a worklet as something other than what it is.
 */
export const installWorkletRequestSchema = Type.Object(
    {
        authorSessionId: Type.String(),
        path: Type.String({ description: "Absolute path of the source folder to import." }),
        iconPath: Type.String({
            description: "Absolute path of the required 512 by 512 PNG worklet icon.",
        }),
        sourceDescription: Type.Optional(
            Type.String({
                description: "Where the sources live, such as the project and folder.",
            }),
        ),
    },
    { additionalProperties: false },
);

export type InstallWorkletRequest = Static<typeof installWorkletRequestSchema>;

export const updateWorkletRequestSchema = Type.Object(
    {
        path: Type.String({ description: "Absolute path of the source folder to import." }),
        changeDescription: Type.String({ description: "What changed in this import." }),
    },
    { additionalProperties: false },
);

export type UpdateWorkletRequest = Static<typeof updateWorkletRequestSchema>;

export const revertWorkletRequestSchema = Type.Object(
    {
        version: Type.Integer({ minimum: 1, description: "The existing version to make current." }),
    },
    { additionalProperties: false },
);

export type RevertWorkletRequest = Static<typeof revertWorkletRequestSchema>;

export interface WorkletResponse {
    worklet: Worklet;
}

export interface ListWorkletsResponse {
    /** Which change this reading reflects, so a live event can be ordered against it. */
    version: EventId;
    worklets: readonly Worklet[];
}

export interface WorkletLogResponse {
    log: string;
    /** True when the read bound omitted older output. */
    truncated: boolean;
}

export type WorkletManagementErrorCode =
    | "invalid_request"
    | "invalid_worklet"
    | "worklet_not_found";

export interface WorkletManagementErrorResponse {
    error: {
        code: WorkletManagementErrorCode;
        message: string;
    };
}

/**
 * Worklets changed. Live-only, carrying the whole current set so a reconnecting client reads the
 * current worklets instead of replaying every past install and state change.
 */
export interface WorkletsChangedEvent {
    createdAt: number;
    data: {
        /** The catalog reading this event carries, comparable with a list response. */
        version: EventId;
        worklets: readonly Worklet[];
    };
    id: EventId;
    type: "worklets_changed";
}
