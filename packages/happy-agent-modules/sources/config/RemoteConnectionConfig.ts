import { connectionIdSchema } from "@slopus/happy-agent-client";
import { Type, type Static } from "@sinclair/typebox";

export const apiTokenSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" });
export const apiConfigSchema = Type.Object(
    {
        token: Type.Optional(apiTokenSchema),
        public_url: Type.Optional(Type.String({ maxLength: 2048 })),
        public_port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    },
    { additionalProperties: false },
);

const fields = {
    enabled: Type.Optional(Type.Literal(true)),
    name: Type.String({
        minLength: 1,
        maxLength: 256,
        pattern: "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$",
    }),
    address: Type.String({ minLength: 3, maxLength: 8192, pattern: "^tc[A-Za-z0-9_-]+$" }),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
};
export const remoteConnectionConfigSchema = Type.Union([
    Type.Object({ ...fields, token: apiTokenSchema }, { additionalProperties: false }),
    Type.Object(
        {
            ...fields,
            workos_organization_id: Type.String({ pattern: "^org_[A-Za-z0-9]+$", maxLength: 160 }),
        },
        { additionalProperties: false },
    ),
    // A server connection by URL: the person signs in, so it carries no address or credential.
    Type.Object(
        {
            enabled: fields.enabled,
            name: fields.name,
            url: Type.String({ minLength: 1, maxLength: 2048, pattern: "^https?://" }),
        },
        { additionalProperties: false },
    ),
]);
export type RemoteConnectionConfig = Static<typeof remoteConnectionConfigSchema>;
export const remoteConnectionEntrySchema = Type.Union([
    remoteConnectionConfigSchema,
    Type.Object({ enabled: Type.Literal(false) }, { additionalProperties: false }),
]);
export type RemoteConnectionEntry = Static<typeof remoteConnectionEntrySchema>;
export const remoteConnectionsConfigSchema = Type.Record(
    connectionIdSchema,
    remoteConnectionEntrySchema,
    {
        additionalProperties: false,
        maxProperties: 100,
    },
);
