import { Type } from "@sinclair/typebox";

import { defineUiComponent } from "../defineUiComponent.js";
import { UiSecret } from "../secret.js";
import { uiSlugSchema, uiTimestampSchema } from "../uiValues.js";

/**
 * Components only Happy Cloud team servers contribute. A standalone daemon never offers them, and
 * its `show_ui` refuses them, but they live in this one catalog so every implementation shares
 * one schema.
 */

const roleSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_-]*$" });

/** An invite for a teammate, with its code shown once in the widget. */
export const inviteComponent = defineUiComponent({
    type: "invite",
    description: "A teammate invite: pick a role, create the invite, copy its code once.",
    props: Type.Object(
        {
            /** The role the picker starts at; `member` when absent. */
            role: Type.Optional(roleSchema),
        },
        { additionalProperties: false },
    ),
    actions: {
        create: {
            payload: Type.Object({ role: roleSchema }, { additionalProperties: false }),
            result: Type.Object(
                {
                    inviteId: Type.String({ minLength: 1, maxLength: 64 }),
                    code: UiSecret(Type.String({ minLength: 1, maxLength: 256 })),
                    expiresAt: uiTimestampSchema,
                    /** The name a teammate joins with, or `null` when the server can't say. */
                    serverName: Type.Union([
                        Type.String({ minLength: 1, maxLength: 256 }),
                        Type.Null(),
                    ]),
                },
                { additionalProperties: false },
            ),
            transcript: "silent",
            permission: "members.manage",
        },
        revoke: {
            payload: Type.Object(
                { inviteId: Type.String({ minLength: 1, maxLength: 64 }) },
                { additionalProperties: false },
            ),
            transcript: "silent",
            permission: "members.manage",
        },
    },
});

/**
 * Connecting GitHub: the team's GitHub App, or the caller's own account by device code. After
 * `device_start` the server polls the device flow itself; the widget follows the existing Git
 * credential state and its event, and has no poll action.
 */
export const githubConnectComponent = defineUiComponent({
    type: "github_connect",
    description:
        "Connect GitHub: install the team's GitHub App, or link your own account with a device code.",
    props: Type.Object({}, { additionalProperties: false }),
    actions: {
        install: {
            payload: Type.Object({}, { additionalProperties: false }),
            result: Type.Object(
                { installUrl: Type.String({ minLength: 1, maxLength: 2_048 }) },
                { additionalProperties: false },
            ),
            transcript: "silent",
            permission: "repositories.manage",
        },
        device_start: {
            payload: Type.Object({}, { additionalProperties: false }),
            result: Type.Object(
                {
                    userCode: UiSecret(Type.String({ minLength: 1, maxLength: 64 })),
                    verificationUri: Type.String({ minLength: 1, maxLength: 2_048 }),
                    expiresAt: uiTimestampSchema,
                },
                { additionalProperties: false },
            ),
            transcript: "silent",
            // It makes the caller's own credential, so reading the conversation is enough.
            permission: { conversation: "read" },
        },
        connect: {
            payload: Type.Object(
                { installationId: Type.String({ minLength: 1, maxLength: 64 }) },
                { additionalProperties: false },
            ),
            transcript: "silent",
            permission: "repositories.manage",
        },
    },
});

/** Adding a machine to a compute pool, with its join commands shown once in the widget. */
export const computeJoinComponent = defineUiComponent({
    type: "compute_join",
    description: "Add a machine to a compute pool: create join commands, then watch it join.",
    props: Type.Object({ pool: Type.Optional(uiSlugSchema) }, { additionalProperties: false }),
    actions: {
        create: {
            payload: Type.Object({}, { additionalProperties: false }),
            result: Type.Object(
                {
                    commands: Type.Array(
                        UiSecret(Type.String({ minLength: 1, maxLength: 4_096 })),
                        {
                            minItems: 1,
                            maxItems: 8,
                        },
                    ),
                    expiresAt: uiTimestampSchema,
                },
                { additionalProperties: false },
            ),
            transcript: "silent",
            permission: "pools.manage",
        },
    },
});

/** This server's link for the phone app. */
export const serverLinkComponent = defineUiComponent({
    type: "server_link",
    description: "This server's address and a code that links the phone app to it.",
    props: Type.Object({}, { additionalProperties: false }),
    actions: {},
});

/** Turning on notifications; asking for the OS permission happens in the client. */
export const notificationsComponent = defineUiComponent({
    type: "notifications",
    description: "Turn on notifications on this device; the client asks for the permission.",
    props: Type.Object({}, { additionalProperties: false }),
    actions: {},
});
