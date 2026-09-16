import { Type, type Static } from "@sinclair/typebox";

/** Trusted controller input, never a model-facing policy or service resource. */
export const supervisorServicePolicySchema = Type.Object(
    {
        root: Type.String({ minLength: 2 }),
        cwd: Type.String({ minLength: 1 }),
        inputs: Type.Array(
            Type.Object(
                {
                    source: Type.String({ minLength: 2 }),
                    destination: Type.String({ minLength: 1 }),
                },
                { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 128 },
        ),
        scratch: Type.Array(Type.String({ minLength: 1 }), { maxItems: 32 }),
        cgroupParent: Type.String({ minLength: 2 }),
        executionId: Type.String({ pattern: "^[a-z0-9]{16,64}$" }),
        controllerPid: Type.Integer({ minimum: 2, maximum: 2147483647 }),
        bridgeSocket: Type.String({ minLength: 2, maxLength: 100 }),
        bridgeToken: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        port: Type.Integer({ minimum: 1024, maximum: 65535 }),
        memoryMiB: Type.Integer({ minimum: 128, maximum: 1024 }),
        processes: Type.Integer({ minimum: 1, maximum: 64 }),
        outbound: Type.Array(
            Type.Object(
                {
                    hostname: Type.String({ minLength: 1, maxLength: 253 }),
                    port: Type.Integer({ minimum: 1, maximum: 65535 }),
                },
                { additionalProperties: false },
            ),
            { maxItems: 32 },
        ),
    },
    { additionalProperties: false },
);
export type SupervisorServicePolicy = Static<typeof supervisorServicePolicySchema>;
