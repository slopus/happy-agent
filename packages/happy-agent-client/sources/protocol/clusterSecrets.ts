/**
 * Happy Cloud's typed secret catalog, served only by a cluster under `/v0/cluster/secrets`. The
 * daemon's environment-bundle secrets in `secrets.ts` are a separate API.
 */

import { type Static, type TSchema, Type } from "@sinclair/typebox";

import {
    cuid2Schema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";
import { secretEnvironmentSchema, secretEnvironmentVariableNameSchema } from "./secrets.js";

/** What people see; the cluster trims it. Names need not be unique. */
export const clusterSecretNameSchema = Type.String({ maxLength: 100, minLength: 1 });

/** Optional prose; the cluster trims it. */
export const clusterSecretDescriptionSchema = Type.String({ maxLength: 2_000 });

/** A host name, an address, or `*.` and a name. */
const hostSchema = Type.String({ maxLength: 255, minLength: 1 });
const portSchema = Type.Integer({ maximum: 65_535, minimum: 1 });
const knownHostsSchema = Type.Array(Type.String({ maxLength: 8_192 }), { maxItems: 32 });

/** Where an endpoint secret applies. Absent lists mean port 443, any path, and any method. */
export const clusterEndpointTargetSchema = Type.Object({
    host: hostSchema,
    methods: Type.Optional(Type.Array(Type.String(), { maxItems: 9 })),
    pathPrefixes: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 16 })),
    ports: Type.Optional(Type.Array(portSchema, { maxItems: 16 })),
});
export type ClusterEndpointTarget = Static<typeof clusterEndpointTargetSchema>;

/** How the egress proxy applies an endpoint secret: each header becomes `prefix` + value. */
export const clusterEndpointAlgorithmSchema = Type.Object({
    headers: Type.Array(
        Type.Object({
            name: Type.String({ minLength: 1 }),
            prefix: Type.Optional(Type.String({ maxLength: 32 })),
        }),
        { maxItems: 8, minItems: 1 },
    ),
    kind: Type.Literal("headers"),
});
export type ClusterEndpointAlgorithm = Static<typeof clusterEndpointAlgorithmSchema>;

export const clusterEndpointPublicSchema = Type.Object({
    algorithm: clusterEndpointAlgorithmSchema,
    targets: Type.Array(clusterEndpointTargetSchema, { maxItems: 16, minItems: 1 }),
});
export type ClusterEndpointPublic = Static<typeof clusterEndpointPublicSchema>;

const sshKeyPublicFields = {
    hosts: Type.Array(hostSchema, { maxItems: 16, minItems: 1 }),
    knownHosts: Type.Optional(knownHostsSchema),
    ports: Type.Optional(Type.Array(portSchema, { maxItems: 8 })),
};

/** An SSH key's metadata. The cluster derives `publicKey` and `fingerprint` from the key. */
export const clusterSshKeyPublicSchema = Type.Object({
    ...sshKeyPublicFields,
    fingerprint: Type.String(),
    publicKey: Type.String(),
});
export type ClusterSshKeyPublic = Static<typeof clusterSshKeyPublicSchema>;

/** SSH key metadata as sent: the derived fields may be omitted, and must match when sent. */
export const clusterSshKeyPublicInputSchema = Type.Object({
    ...sshKeyPublicFields,
    fingerprint: Type.Optional(Type.String()),
    publicKey: Type.Optional(Type.String()),
});
export type ClusterSshKeyPublicInput = Static<typeof clusterSshKeyPublicInputSchema>;

export const clusterGitOperationSchema = Type.Union([
    Type.Literal("read"),
    Type.Literal("write"),
    Type.Literal("sign"),
]);
export type ClusterGitOperation = Static<typeof clusterGitOperationSchema>;

export const clusterGitSshKeyMethodSchema = Type.Object({
    fingerprint: Type.String(),
    kind: Type.Literal("ssh_key"),
    knownHosts: Type.Optional(knownHostsSchema),
    publicKey: Type.String(),
});
const gitSshKeyMethodInputSchema = Type.Object({
    fingerprint: Type.Optional(Type.String()),
    kind: Type.Literal("ssh_key"),
    knownHosts: Type.Optional(knownHostsSchema),
    publicKey: Type.Optional(Type.String()),
});
/** HTTPS basic authentication with an app password. */
export const clusterGitPasswordMethodSchema = Type.Object({
    kind: Type.Literal("password"),
    username: Type.String({ maxLength: 128, minLength: 1 }),
});
/** An access token: basic authentication with `username`, or a bearer token without one. */
export const clusterGitTokenMethodSchema = Type.Object({
    kind: Type.Literal("token"),
    username: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
});

const gitCredentialPublicFields = {
    operations: Type.Array(clusterGitOperationSchema, { maxItems: 3, minItems: 1 }),
    port: Type.Optional(portSchema),
    repos: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
    server: hostSchema,
};

/** How git authenticates to exactly one server. */
export const clusterGitCredentialPublicSchema = Type.Object({
    ...gitCredentialPublicFields,
    method: Type.Union([
        clusterGitSshKeyMethodSchema,
        clusterGitPasswordMethodSchema,
        clusterGitTokenMethodSchema,
    ]),
});
export type ClusterGitCredentialPublic = Static<typeof clusterGitCredentialPublicSchema>;

/** The bundle's variable names, sorted; derived from the material. */
export const clusterEnvironmentPublicSchema = Type.Object({
    variables: Type.Array(secretEnvironmentVariableNameSchema, { maxItems: 256 }),
});
export type ClusterEnvironmentPublic = Static<typeof clusterEnvironmentPublicSchema>;

const environmentPublicInputSchema = Type.Object({
    variables: Type.Optional(Type.Array(secretEnvironmentVariableNameSchema, { maxItems: 256 })),
});

export const clusterSecretUseSchema = Type.Union([
    Type.Literal("egress"),
    Type.Literal("git"),
    Type.Literal("ssh"),
    Type.Literal("mcp"),
    Type.Literal("environment"),
]);
export type ClusterSecretUse = Static<typeof clusterSecretUseSchema>;

const endpointUsesSchema = Type.Array(Type.Union([Type.Literal("egress"), Type.Literal("mcp")]));
const sshKeyUsesSchema = Type.Array(Type.Literal("ssh"));
const gitCredentialUsesSchema = Type.Array(Type.Literal("git"));
const environmentUsesSchema = Type.Array(
    Type.Union([Type.Literal("environment"), Type.Literal("mcp")]),
);

export const clusterSecretTypeSchema = Type.Union([
    Type.Literal("endpoint"),
    Type.Literal("ssh_key"),
    Type.Literal("git_credential"),
    Type.Literal("environment"),
]);
export type ClusterSecretType = Static<typeof clusterSecretTypeSchema>;

/** A role ID, built in (`owner`, `admin`, `member`, `viewer`) or custom. */
export const clusterSecretRoleIdSchema = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" });

export const clusterSecretRoleLevelSchema = Type.Union([
    Type.Literal("none"),
    Type.Literal("use"),
    Type.Literal("manage"),
]);
export type ClusterSecretRoleLevel = Static<typeof clusterSecretRoleLevelSchema>;

/** One role's rule on a team secret. */
export const clusterSecretRoleRuleSchema = Type.Object({
    hidden: Type.Boolean(),
    level: clusterSecretRoleLevelSchema,
});
export type ClusterSecretRoleRule = Static<typeof clusterSecretRoleRuleSchema>;

/** Rules as sent: `level` defaults to `none` and `hidden` to `false`. */
export const clusterSecretRolesInputSchema = Type.Record(
    clusterSecretRoleIdSchema,
    Type.Object(
        {
            hidden: Type.Optional(Type.Boolean()),
            level: Type.Optional(clusterSecretRoleLevelSchema),
        },
        { additionalProperties: false },
    ),
    { additionalProperties: false, maxProperties: 64 },
);
export type ClusterSecretRolesInput = Static<typeof clusterSecretRolesInputSchema>;

/** What the caller may do with a secret. */
export const clusterSecretAccessSchema = Type.Object({
    attach: Type.Boolean(),
    manage: Type.Boolean(),
    use: Type.Boolean(),
});
export type ClusterSecretAccess = Static<typeof clusterSecretAccessSchema>;

const clusterSecretFields = {
    access: clusterSecretAccessSchema,
    createdAt: timestampSchema,
    description: clusterSecretDescriptionSchema,
    id: cuid2Schema,
    /** Values are write-only; forbidden even though responses tolerate future metadata fields. */
    material: Type.Optional(Type.Never()),
    name: clusterSecretNameSchema,
    owner: Type.Union([Type.Literal("me"), Type.Literal("team")]),
    /** Present only on a team secret the caller manages. */
    roles: Type.Optional(Type.Record(clusterSecretRoleIdSchema, clusterSecretRoleRuleSchema)),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
};

/** A cluster secret's metadata, discriminated by `type`. Values never appear in this shape. */
export const clusterSecretSchema = Type.Union([
    Type.Object({
        ...clusterSecretFields,
        public: clusterEndpointPublicSchema,
        type: Type.Literal("endpoint"),
        uses: endpointUsesSchema,
    }),
    Type.Object({
        ...clusterSecretFields,
        public: clusterSshKeyPublicSchema,
        type: Type.Literal("ssh_key"),
        uses: sshKeyUsesSchema,
    }),
    Type.Object({
        ...clusterSecretFields,
        public: clusterGitCredentialPublicSchema,
        type: Type.Literal("git_credential"),
        uses: gitCredentialUsesSchema,
    }),
    Type.Object({
        ...clusterSecretFields,
        public: clusterEnvironmentPublicSchema,
        type: Type.Literal("environment"),
        uses: environmentUsesSchema,
    }),
]);
export type ClusterSecret = Static<typeof clusterSecretSchema>;

/** A value the proxy or git broker injects: 16–4,096 printable ASCII bytes without `[` or `]`. */
export const clusterSecretInjectableValueSchema = Type.String({
    maxLength: 4_096,
    minLength: 16,
    pattern: "^[\\x20-\\x5A\\x5C\\x5E-\\x7E]+$",
});

/** An endpoint's write-only values, one per header in `algorithm.headers`. */
export const clusterEndpointMaterialSchema = Type.Record(
    Type.String({ minLength: 1 }),
    clusterSecretInjectableValueSchema,
    { maxProperties: 8, minProperties: 1 },
);
export type ClusterEndpointMaterial = Static<typeof clusterEndpointMaterialSchema>;

/** A write-only OpenSSH private key. */
export const clusterSshKeyMaterialSchema = Type.Object(
    {
        passphrase: Type.Optional(Nullable(Type.String({ maxLength: 1_024, minLength: 1 }))),
        privateKey: Type.String({ maxLength: 16_384, minLength: 1 }),
    },
    { additionalProperties: false },
);
export type ClusterSshKeyMaterial = Static<typeof clusterSshKeyMaterialSchema>;

export const clusterGitPasswordMaterialSchema = Type.Object(
    { password: clusterSecretInjectableValueSchema },
    { additionalProperties: false },
);
export type ClusterGitPasswordMaterial = Static<typeof clusterGitPasswordMaterialSchema>;

export const clusterGitTokenMaterialSchema = Type.Object(
    { token: clusterSecretInjectableValueSchema },
    { additionalProperties: false },
);
export type ClusterGitTokenMaterial = Static<typeof clusterGitTokenMaterialSchema>;

const createFields = {
    description: Type.Optional(clusterSecretDescriptionSchema),
    mutationId: Type.Optional(mutationIdSchema),
    name: clusterSecretNameSchema,
    /** `me` for the caller's own secret, which takes no `roles`; the team's by default. */
    owner: Type.Optional(Type.Union([Type.Literal("me"), Type.Literal("team")])),
    roles: Type.Optional(clusterSecretRolesInputSchema),
};

function createGitCredential<Method extends TSchema, Material extends TSchema>(
    method: Method,
    material: Material,
) {
    return Type.Object(
        {
            ...createFields,
            material,
            public: Type.Object({ ...gitCredentialPublicFields, method }),
            type: Type.Literal("git_credential"),
            uses: gitCredentialUsesSchema,
        },
        { additionalProperties: false },
    );
}

/** `POST /v0/cluster/secrets`, discriminated by `type`; a git credential's material follows its method. */
export const createClusterSecretRequestSchema = Type.Union([
    Type.Object(
        {
            ...createFields,
            material: clusterEndpointMaterialSchema,
            public: clusterEndpointPublicSchema,
            type: Type.Literal("endpoint"),
            uses: endpointUsesSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...createFields,
            material: clusterSshKeyMaterialSchema,
            public: clusterSshKeyPublicInputSchema,
            type: Type.Literal("ssh_key"),
            uses: sshKeyUsesSchema,
        },
        { additionalProperties: false },
    ),
    createGitCredential(gitSshKeyMethodInputSchema, clusterSshKeyMaterialSchema),
    createGitCredential(clusterGitPasswordMethodSchema, clusterGitPasswordMaterialSchema),
    createGitCredential(clusterGitTokenMethodSchema, clusterGitTokenMaterialSchema),
    Type.Object(
        {
            ...createFields,
            material: secretEnvironmentSchema,
            public: Type.Optional(environmentPublicInputSchema),
            type: Type.Literal("environment"),
            uses: environmentUsesSchema,
        },
        { additionalProperties: false },
    ),
]);
export type CreateClusterSecretRequest = Static<typeof createClusterSecretRequestSchema>;

/** Any type's metadata as sent; the type itself never changes. */
export const clusterSecretPublicInputSchema = Type.Union([
    clusterEndpointPublicSchema,
    clusterSshKeyPublicInputSchema,
    Type.Object({
        ...gitCredentialPublicFields,
        method: Type.Union([
            gitSshKeyMethodInputSchema,
            clusterGitPasswordMethodSchema,
            clusterGitTokenMethodSchema,
        ]),
    }),
    environmentPublicInputSchema,
]);
export type ClusterSecretPublicInput = Static<typeof clusterSecretPublicInputSchema>;

/** Any type's write-only material. */
export const clusterSecretMaterialSchema = Type.Union([
    clusterEndpointMaterialSchema,
    clusterSshKeyMaterialSchema,
    clusterGitPasswordMaterialSchema,
    clusterGitTokenMaterialSchema,
    secretEnvironmentSchema,
]);
export type ClusterSecretMaterial = Static<typeof clusterSecretMaterialSchema>;

const updateOptionalFields = {
    description: Type.Optional(clusterSecretDescriptionSchema),
    mutationId: Type.Optional(mutationIdSchema),
    name: Type.Optional(clusterSecretNameSchema),
    roles: Type.Optional(clusterSecretRolesInputSchema),
    uses: Type.Optional(Type.Array(clusterSecretUseSchema)),
};

/**
 * `PATCH /v0/cluster/secrets/:secretId`; at least one field changes. `public` replaces the whole
 * metadata and is accepted only with `material`, so a value is entered again wherever it goes.
 */
export const updateClusterSecretRequestSchema = Type.Union([
    Type.Object(
        { ...updateOptionalFields, name: clusterSecretNameSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...updateOptionalFields, description: clusterSecretDescriptionSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...updateOptionalFields, uses: Type.Array(clusterSecretUseSchema) },
        { additionalProperties: false },
    ),
    Type.Object(
        { ...updateOptionalFields, roles: clusterSecretRolesInputSchema },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...updateOptionalFields,
            material: clusterSecretMaterialSchema,
            public: Type.Optional(clusterSecretPublicInputSchema),
        },
        { additionalProperties: false },
    ),
]);
export type UpdateClusterSecretRequest = Static<typeof updateClusterSecretRequestSchema>;

/** The optional body of delete, grant, and revoke; an empty body is equivalent to `{}`. */
export const clusterSecretMutationRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type ClusterSecretMutationRequest = Static<typeof clusterSecretMutationRequestSchema>;

/** `GET /v0/cluster/secrets` query. */
export const clusterSecretListQuerySchema = Type.Object(
    {
        /** The previous page's opaque `nextCursor`. */
        cursor: Type.Optional(Type.String({ minLength: 1 })),
        limit: Type.Optional(Type.Integer({ maximum: 100, minimum: 1 })),
    },
    { additionalProperties: false },
);
export type ClusterSecretListQuery = Static<typeof clusterSecretListQuerySchema>;

/** `GET /v0/cluster/secrets` */
export const clusterSecretListResponseSchema = Type.Object({
    nextCursor: Nullable(Type.String()),
    secrets: Type.Array(clusterSecretSchema, { maxItems: 100 }),
});
export type ClusterSecretListResponse = Static<typeof clusterSecretListResponseSchema>;

/** `GET`, `POST`, and `PATCH` of one cluster secret. */
export const clusterSecretResponseSchema = Type.Object({ secret: clusterSecretSchema });
export type ClusterSecretResponse = Static<typeof clusterSecretResponseSchema>;

/** `DELETE /v0/cluster/secrets/:secretId` */
export const clusterSecretDeleteResponseSchema = Type.Object({
    deleted: Type.Literal(true),
    secretId: cuid2Schema,
});
export type ClusterSecretDeleteResponse = Static<typeof clusterSecretDeleteResponseSchema>;

export const clusterSecretGrantTargetTypeSchema = Type.Union([
    Type.Literal("agent"),
    Type.Literal("workspace"),
]);
export type ClusterSecretGrantTargetType = Static<typeof clusterSecretGrantTargetTypeSchema>;

/** The agent or workspace a grant delivers the secret to. */
export const clusterSecretGrantTargetSchema = Type.Object({
    id: cuid2Schema,
    type: clusterSecretGrantTargetTypeSchema,
});
export type ClusterSecretGrantTarget = Static<typeof clusterSecretGrantTargetSchema>;

/** One grant, identified by its secret and target. */
export const clusterSecretGrantSchema = Type.Object({
    createdAt: timestampSchema,
    grantedBy: Type.String(),
    secretId: cuid2Schema,
    target: clusterSecretGrantTargetSchema,
});
export type ClusterSecretGrant = Static<typeof clusterSecretGrantSchema>;

/** `GET /v0/cluster/secrets/:secretId/grants`, unpaged. */
export const clusterSecretGrantListResponseSchema = Type.Object({
    grants: Type.Array(clusterSecretGrantSchema),
});
export type ClusterSecretGrantListResponse = Static<typeof clusterSecretGrantListResponseSchema>;

/** `PUT .../grants/:targetType/:targetId`; `version` is the secret's after the request. */
export const clusterSecretGrantResponseSchema = Type.Object({
    created: Type.Boolean(),
    grant: clusterSecretGrantSchema,
    version: resourceVersionSchema,
});
export type ClusterSecretGrantResponse = Static<typeof clusterSecretGrantResponseSchema>;

/** `DELETE .../grants/:targetType/:targetId`; `grant` is `null` when there was none. */
export const clusterSecretRevokeResponseSchema = Type.Object({
    grant: Nullable(clusterSecretGrantSchema),
    revoked: Type.Boolean(),
    version: resourceVersionSchema,
});
export type ClusterSecretRevokeResponse = Static<typeof clusterSecretRevokeResponseSchema>;
