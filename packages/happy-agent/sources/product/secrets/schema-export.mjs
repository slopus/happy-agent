// Build-time Source capture; the native owner never loads JavaScript.
import { createRequire } from "node:module";
import * as legacy from "../../../../happy-agent-modules/sources/secrets/Secret.ts";
import * as api from "../../../../happy-agent-modules/sources/secrets/SecretApi.ts";
import { secretEventSchema } from "../../../../happy-agent-modules/sources/secrets/SecretEvent.ts";
import { secretDotenvFileSchema } from "../../../../happy-agent-modules/sources/secrets/tools/secretDotenv.ts";
import { listSecretsTool } from "../../../../happy-agent-modules/sources/secrets/tools/list_secrets.ts";
import { referenceSecretTool } from "../../../../happy-agent-modules/sources/secrets/tools/reference_secret.ts";
import { createSecretTool } from "../../../../happy-agent-modules/sources/secrets/tools/create_secret.ts";
import { updateSecretTool } from "../../../../happy-agent-modules/sources/secrets/tools/update_secret.ts";
import { attachSecretTool } from "../../../../happy-agent-modules/sources/secrets/tools/attach_secret.ts";
import { detachSecretTool } from "../../../../happy-agent-modules/sources/secrets/tools/detach_secret.ts";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";

const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { Type } = require("@sinclair/typebox");
const client = await import(require.resolve("@slopus/happy-agent-client"));
const base = await import(require.resolve("@slopus/happy-agent-base"));
const privateSchemas = await sourcePrivateSchema(
    new URL("../../../../happy-agent-modules/sources/secrets/SecretsModule.ts", import.meta.url),
    ["secretManagedKindSchema", "MAX_SECRET_LIST_ITEMS"],
);
export const secretTools = [
    listSecretsTool(undefined),
    referenceSecretTool(undefined),
    createSecretTool(undefined),
    updateSecretTool(undefined),
    attachSecretTool(undefined, "source-reference-agent"),
    detachSecretTool(undefined, "source-reference-agent"),
];
const exact = { additionalProperties: false };
const nullable = (schema) => Type.Union([schema, Type.Null()]);
export const secretSchemas = {
    secretId: api.secretApiIdSchema,
    secretVersion: api.secretApiVersionSchema,
    secretDescription: legacy.secretDescriptionSchema,
    secretLegacyId: legacy.secretIdSchema,
    secretActorId: legacy.secretAgentIdSchema,
    secretScope: legacy.secretScopeRefSchema,
    secretReference: legacy.secretReferenceSchema,
    secretLegacyRegistration: legacy.secretRegistrationInputSchema,
    secretLegacyUpdate: legacy.secretUpdateInputSchema,
    secretLegacyAttachment: legacy.secretAttachmentSchema,
    secretLegacyList: legacy.secretListQuerySchema,
    secretLegacyPage: legacy.secretPageSchema,
    secretHostEnvironment: legacy.secretHostEnvironmentSchema,
    secretEnvironmentName: legacy.secretEnvironmentVariableNameSchema,
    secretCommandEnvironment: legacy.secretCommandEnvironmentSchema,
    secretSelectedIds: Type.Array(legacy.secretIdSchema, {
        uniqueItems: true,
        maxItems: privateSchemas.MAX_SECRET_LIST_ITEMS,
    }),
    secretCommandTargets: Type.Array(
        Type.Union([
            Type.Object({ type: Type.Literal("agent"), id: legacy.secretAgentIdSchema }, exact),
            Type.Object(
                {
                    type: Type.Union([Type.Literal("project"), Type.Literal("workspace")]),
                    id: api.secretApiTargetSchema.properties.id,
                },
                exact,
            ),
        ]),
        { minItems: 1, maxItems: 3, uniqueItems: true },
    ),
    secretRecord: api.secretApiRecordSchema,
    secretCreate: api.secretApiCreateInputSchema,
    secretUpdate: api.secretApiUpdateInputSchema,
    secretTarget: api.secretApiTargetSchema,
    secretList: api.secretApiListQuerySchema,
    secretAttachmentList: api.secretApiAttachmentListQuerySchema,
    secretAttachment: api.secretApiAttachmentSchema,
    secretPage: api.secretApiPageSchema,
    secretAttachmentPage: api.secretApiAttachmentPageSchema,
    secretManagedKind: privateSchemas.secretManagedKindSchema,
    secretEvent: secretEventSchema,
    secretDotenvFile: secretDotenvFileSchema,
    secretCreateRequest: client.createSecretRequestSchema,
    secretUpdateRequest: client.updateSecretRequestSchema,
    secretAttachmentMutationRequest: client.secretAttachmentMutationRequestSchema,
    secretAttachmentId: base.cuid2Schema,
    // SQL transport only. Parse and validate environment and metadata through
    // their Source schemas after decoding these exact original columns.
    secretStoredRow: Type.Object(
        {
            owner_agent_id: Type.String(),
            id: legacy.secretIdSchema,
            description: legacy.secretDescriptionSchema,
            environment_json: Type.String({ minLength: 1, maxLength: 108 * 1024 * 1024 }),
            revision: legacy.secretRevisionSchema,
            available_to_model: nullable(
                Type.Union([
                    Type.Literal(0),
                    Type.Literal(1),
                    Type.Literal("0"),
                    Type.Literal("1"),
                ]),
            ),
            kind: nullable(privateSchemas.secretManagedKindSchema),
            public_version: nullable(api.secretApiVersionSchema),
            created_at: nullable(api.secretApiTimestampSchema),
            updated_at: nullable(api.secretApiTimestampSchema),
        },
        exact,
    ),
    secretMigrationRow: Type.Object({ owner_agent_id: Type.String(), id: Type.String() }, exact),
};
for (const tool of secretTools) {
    secretSchemas[`secretTool_${tool.name}`] = tool.parameters;
    secretSchemas[`secretResult_${tool.name}`] = tool.returnType;
}
