// Build-time capture of the original Services TypeBox contracts. The released
// Rust owner consumes serialized schemas, never this JavaScript module.
import { createRequire } from "node:module";
import {
    serviceDefinitionSchema,
    serviceInputOptionsSchema,
    serviceExecutionCallSchema,
    serviceEventSchema,
} from "../../../../happy-agent-modules/sources/services/Service.ts";
import { serviceReaderSchema } from "../../../../happy-agent-modules/sources/services/impl/ServiceOutputReaders.ts";
import {
    computeServiceExecutionSchema,
    computeServiceStartSchema,
} from "../../../../happy-agent-compute/sources/ComputeServices.ts";
import { agentComputeConfigSchema } from "../../../../happy-agent-modules/sources/compute/ComputeModule.ts";
import { serviceLifetimeSchema } from "../../../../happy-agent-compute/sources/services/serviceControlFiles.ts";
import { supervisorPolicySchema } from "../../../../happy-agent-supervisor/sources/SupervisorPolicy.ts";
import { sourcePrivateSchema } from "../../../scripts/source-private-schema.mjs";

const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { workspaceServiceCleanupSchema, workspaceServiceListQuerySchema } = await import(
    require.resolve("@slopus/happy-agent-client")
);
const records = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/services/persistence/ServiceRecords.ts",
        import.meta.url,
    ),
    ["recordSchema", "headerSchema", "indexPageSchema"],
);
const tokens = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/services/impl/ServiceAccessTokens.ts",
        import.meta.url,
    ),
    ["scopeSchema", "payloadSchema", "tokenSchema"],
);
const paging = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-modules/sources/services/impl/ServicePageCursor.ts",
        import.meta.url,
    ),
    ["cursorSchema", "encodedSchema"],
);
const kernel = await sourcePrivateSchema(
    new URL(
        "../../../../happy-agent-compute/sources/services/reconcileServiceExecution.ts",
        import.meta.url,
    ),
    ["kernelIdentitySchema"],
);
export const serviceSchemas = {
    serviceAgentCompute: agentComputeConfigSchema,
    serviceDefinition: serviceDefinitionSchema,
    serviceListQuery: workspaceServiceListQuerySchema,
    servicePagePosition: paging.cursorSchema,
    serviceEncodedCursor: paging.encodedSchema,
    serviceInputOptions: serviceInputOptionsSchema,
    serviceExecutionCall: serviceExecutionCallSchema,
    serviceReader: serviceReaderSchema,
    serviceEvent: serviceEventSchema,
    serviceStartOptions: computeServiceStartSchema,
    serviceExecution: computeServiceExecutionSchema,
    serviceLifetime: serviceLifetimeSchema,
    serviceKernelIdentity: kernel.kernelIdentitySchema,
    supervisorPolicy: supervisorPolicySchema,
    workspaceServiceCleanup: workspaceServiceCleanupSchema,
    serviceStoredRecord: records.recordSchema,
    serviceHeader: records.headerSchema,
    serviceIndexPage: records.indexPageSchema,
    serviceAccessScope: tokens.scopeSchema,
    serviceAccessPayload: tokens.payloadSchema,
    serviceAccessToken: tokens.tokenSchema,
};
