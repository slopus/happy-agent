import { cuid2Schema } from "@slopus/happy-agent-base";
import {
    workspaceServiceCreatedPayloadSchema,
    workspaceServiceUpdatedPayloadSchema,
} from "@slopus/happy-agent-client";
import { computeServiceStartSchema } from "@slopus/happy-agent-compute";
import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
/** Already normalized inputs owned by the common tool, without a model-selected workspace. */
export const serviceDefinitionSchema = Type.Object(
    {
        name: Type.String({
            minLength: 1,
            maxLength: 128,
            pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]+$",
        }),
        ...Type.Pick(computeServiceStartSchema, ["command", "cwd", "port", "tty", "sandbox"])
            .properties,
    },
    exact,
);
export type ServiceDefinition = Static<typeof serviceDefinitionSchema>;

export const serviceExecutionCallSchema = Type.Object(
    {
        workspaceId: cuid2Schema,
        serviceId: cuid2Schema,
        daemonId: cuid2Schema,
        options: computeServiceStartSchema,
    },
    exact,
);
export type ServiceExecutionCall = Static<typeof serviceExecutionCallSchema>;

export const serviceEventSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("service.created"),
            ...workspaceServiceCreatedPayloadSchema.properties,
        },
        exact,
    ),
    Type.Object(
        {
            type: Type.Literal("service.updated"),
            ...workspaceServiceUpdatedPayloadSchema.properties,
        },
        exact,
    ),
]);
export type ServiceEvent = Static<typeof serviceEventSchema>;
export type ServiceEventListener = (event: ServiceEvent) => void | Promise<void>;

/** Semantic failure codes shared by the agent and HTTP adapters; messages never include credentials. */
export type ServiceErrorCode =
    | "not_found"
    | "service_not_running"
    | "service_unavailable"
    | "output_unavailable"
    | "reader_limit"
    | "invalid_request";
export class ServiceError extends Error {
    constructor(
        readonly code: ServiceErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "ServiceError";
    }
}
