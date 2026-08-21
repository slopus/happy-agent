import { Type, type Static } from "@sinclair/typebox";

import { happyComputeErrorSchema } from "./PluginWireTypes.js";

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ minLength: 1 });

export const SERVICE_NOTICE_MESSAGE_MAX_LENGTH = 4_096;
export const SERVICE_NOTICE_TEXT_MAX_LENGTH = 8_192;

export const computePreparationNoticeSchema = Type.Object(
    {
        computeInstanceId: nonEmptyText,
        elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
        error: Type.Optional(happyComputeErrorSchema),
        kind: Type.Literal("compute_preparation"),
        lastProgressAt: Type.Optional(Type.Integer({ minimum: 0 })),
        message: Type.String({ maxLength: SERVICE_NOTICE_MESSAGE_MAX_LENGTH, minLength: 1 }),
        percent: Type.Optional(Type.Number({ maximum: 100, minimum: 0 })),
        phase: Type.String({ maxLength: 128, minLength: 1 }),
        provider: nonEmptyText,
        startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        state: Type.Union([
            Type.Literal("failed"),
            Type.Literal("provisioning"),
            Type.Literal("ready"),
            Type.Literal("stopped"),
            Type.Literal("unprovisioned"),
            Type.Literal("unavailable"),
        ]),
    },
    exact,
);
export type ComputePreparationNotice = Static<typeof computePreparationNoticeSchema>;

/**
 * A plain visible notice a client can render more richly than its fallback text: a titled service
 * row at a stated importance. Permission outcomes that stopped or skipped work — a turn ended by
 * repeated refusals, an action left unproven, a failed elevated-session cleanup — arrive this way.
 */
export const genericNoticeSchema = Type.Object(
    {
        kind: Type.Literal("notice"),
        title: Type.String({ maxLength: SERVICE_NOTICE_MESSAGE_MAX_LENGTH, minLength: 1 }),
        details: Type.String({ maxLength: SERVICE_NOTICE_TEXT_MAX_LENGTH, minLength: 1 }),
        level: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
        /**
         * A stable machine code for notices a client must react to beyond rendering. It exists so a
         * client keys that behavior to a durable identifier rather than to the human-facing title,
         * which is display text and free to change. The turn-stop notice carries
         * `"permission_turn_stopped"` so the app can suppress the generic interruption row for the
         * same run without matching the title.
         */
        code: Type.Optional(Type.String({ maxLength: 128 })),
    },
    exact,
);
export type GenericNotice = Static<typeof genericNoticeSchema>;

export const serviceNoticeSchema = Type.Union([
    computePreparationNoticeSchema,
    genericNoticeSchema,
]);
export type ServiceNotice = Static<typeof serviceNoticeSchema>;

/**
 * A service-style transcript row.
 *
 * `text` is required so clients that do not understand `structured.kind` still have a complete,
 * human-readable message to render.
 */
export const systemNoticePayloadSchema = Type.Object(
    {
        structured: Type.Optional(serviceNoticeSchema),
        text: Type.String({ maxLength: SERVICE_NOTICE_TEXT_MAX_LENGTH, minLength: 1 }),
    },
    exact,
);
export type SystemNoticePayload = Static<typeof systemNoticePayloadSchema>;
