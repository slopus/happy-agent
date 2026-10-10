// Build-time TypeBox schemas for the private, same-executable container carrier.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import {
    dockerExecutionConfigSchema,
    dockerHostPolicyConfigSchema,
} from "../../../../happy-agent-compute/sources/docker/DockerExecutionConfig.ts";
const require = createRequire(
    new URL("../../../../happy-agent-modules/package.json", import.meta.url),
);
const { Type } = require("@sinclair/typebox");
const source = JSON.parse(
    readFileSync(new URL("../request_schemas.json", import.meta.url), "utf8"),
);
const exact = { additionalProperties: false };
const identity = Type.String({ minLength: 1, maxLength: 128 });
const bindings = Type.Array(
    Type.Object(
        {
            path: Type.String({ maxLength: 4096 }),
            target: Type.String({ maxLength: 4096 }),
            write: Type.Boolean(),
        },
        exact,
    ),
    { maxItems: 1024 },
);
const schemas = {
    ownerRunnerParams_compute_createContainer: Type.Object(
        {
            computeId: identity,
            cwd: source.ownerRunnerParams_compute_create.properties.cwd,
            policy: Type.Optional(dockerHostPolicyConfigSchema),
        },
        exact,
    ),
    dockerEnvironmentRequest: Type.Object(
        {
            computeId: source.ownerRunnerParams_compute_create.properties.computeId,
            cwd: source.ownerRunnerParams_compute_create.properties.cwd,
            policy: Type.Optional(dockerHostPolicyConfigSchema),
            docker: dockerExecutionConfigSchema,
        },
        exact,
    ),
    ownerRunnerParams_compute_fileTool: Type.Object(
        {
            computeId: identity,
            agent: identity,
            vendor: source.computeToolVendor,
            mode: source.permissionMode,
            call: Type.Object({
                id: identity,
                call: Type.Object({
                    name: identity,
                    arguments: Type.String({ maxLength: 32 * 1024 * 1024 }),
                    namespace: Type.Optional(identity),
                }),
            }),
            reads: source.computeFileReadLog,
            bindings: Type.Optional(bindings),
        },
        exact,
    ),
    ownerRunnerResult_compute_fileTool: Type.Object(
        {
            blocks: Type.Array(
                Type.Union([
                    Type.Object(
                        {
                            type: Type.Literal("text"),
                            text: Type.String({ maxLength: 64 * 1024 * 1024 }),
                        },
                        exact,
                    ),
                    Type.Object(
                        {
                            type: Type.Literal("image"),
                            data: Type.String({ maxLength: 64 * 1024 * 1024 }),
                            mimeType: Type.String({ maxLength: 128 }),
                        },
                        exact,
                    ),
                ]),
                { maxItems: 16 },
            ),
            isError: Type.Boolean(),
            reads: source.computeFileReadLog,
            presentation: Type.Optional(source.computeFileDiffPresentation),
        },
        exact,
    ),
};
schemas.ownerRunnerParams_compute_filePolicy = schemas.ownerRunnerParams_compute_fileTool;
schemas.ownerRunnerParams_compute_secretShell = Type.Object(
    {
        computeId: identity,
        options: source.ownerRunnerParams_shell_startSession.properties.options,
        environment: source.secretHostEnvironment,
        hiddenEnvironmentVariables: Type.Array(Type.String({ maxLength: 1024 }), {
            maxItems: 4096,
        }),
    },
    exact,
);
schemas.ownerRunnerResult_compute_secretShell = source.ownerRunnerResult_shell_startSession;
schemas.ownerRunnerResult_compute_filePolicy = Type.Object(
    {
        review: Type.Boolean(),
        full: Type.Boolean(),
        requires: Type.Boolean(),
        action: Type.String({ maxLength: 1024 * 1024 }),
        instructions: Type.Union([Type.String({ maxLength: 1024 * 1024 }), Type.Null()]),
        bindings,
    },
    exact,
);
schemas.dockerEnvironmentRecord = Type.Object(
    {
        request: schemas.dockerEnvironmentRequest,
        closing: Type.Boolean(),
        container: Type.Optional(identity),
        exec: Type.Optional(identity),
    },
    exact,
);
writeFileSync(new URL("schemas.json", import.meta.url), JSON.stringify(schemas, null, 2) + "\n");
