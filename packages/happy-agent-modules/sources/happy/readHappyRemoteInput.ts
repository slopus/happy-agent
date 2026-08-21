import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { HAPPY_SENT_FROM_RIG, type HappyRemoteInput } from "./HappyProtocol.js";

const recordSchema = Type.Record(Type.String(), Type.Unknown());

const metaSchema = Type.Object(
    {
        effort: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        modelProviderId: Type.Optional(Type.String()),
        permissionMode: Type.Optional(Type.String()),
        providerId: Type.Optional(Type.String()),
        reasoning: Type.Optional(Type.String()),
        sentFrom: Type.Optional(Type.String()),
        thinkingLevel: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const plainTextSchema = Type.Object(
    {
        content: Type.Object(
            { text: Type.String(), type: Type.Literal("text") },
            { additionalProperties: true },
        ),
        meta: Type.Optional(metaSchema),
        role: Type.Literal("user"),
    },
    { additionalProperties: true },
);

const envelopeSchema = Type.Object(
    {
        ev: Type.Object({ t: Type.String() }, { additionalProperties: true }),
        meta: Type.Optional(metaSchema),
        role: Type.String(),
    },
    { additionalProperties: true },
);

const attachmentEventSchema = Type.Object(
    {
        mimeType: Type.Optional(Type.String()),
        name: Type.String({ minLength: 1 }),
        ref: Type.String({ minLength: 1 }),
        size: Type.Number(),
        t: Type.Literal("file"),
    },
    { additionalProperties: true },
);

const textEventSchema = Type.Object(
    { t: Type.Literal("text"), text: Type.String() },
    { additionalProperties: true },
);

const wrappedSchema = Type.Object(
    {
        content: Type.Object(
            { type: Type.Optional(Type.String()) },
            { additionalProperties: true },
        ),
        meta: Type.Optional(metaSchema),
        role: Type.String(),
    },
    { additionalProperties: true },
);

/**
 * Reads what one decrypted message from Happy actually is.
 *
 * The phone has said the same thing in more than one shape over the years, and
 * Happy Agent has to understand all of them, so this accepts each and answers with the
 * one thing they mean. Anything it does not recognize is answered as nothing at
 * all, because guessing at a message would put words in a person's mouth.
 */
export function readHappyRemoteInput(value: unknown): HappyRemoteInput | undefined {
    if (!Value.Check(recordSchema, value)) return undefined;
    const outerMeta = Value.Check(metaSchema, value.meta) ? value.meta : undefined;
    // Happy Agent's own message coming back around; it says nothing new.
    if (outerMeta?.sentFrom === HAPPY_SENT_FROM_RIG) return { kind: "echo" };

    if (Value.Check(plainTextSchema, value)) {
        return { kind: "text", selection: readSelection(outerMeta), text: value.content.text };
    }
    if (!Value.Check(wrappedSchema, value) || value.role !== "session") return undefined;
    const nested = (value.content as { data?: unknown }).data;
    const envelope = value.content.type === "session" ? nested : value.content;
    if (!Value.Check(envelopeSchema, envelope) || envelope.role !== "user") return undefined;
    if (Value.Check(attachmentEventSchema, envelope.ev)) {
        return {
            kind: "attachment",
            ...(envelope.ev.mimeType === undefined ? {} : { mimeType: envelope.ev.mimeType }),
            name: envelope.ev.name,
            ref: envelope.ev.ref,
            size: envelope.ev.size,
        };
    }
    if (Value.Check(textEventSchema, envelope.ev)) {
        return {
            kind: "text",
            selection: readSelection(envelope.meta ?? outerMeta),
            text: envelope.ev.text,
        };
    }
    return undefined;
}

/** Reads what the person chose on the phone, under any of the names it has used. */
function readSelection(meta: Record<string, unknown> | undefined): {
    effort?: string;
    modelId?: string;
    permissionMode?: string;
    providerId?: string;
} {
    if (meta === undefined) return {};
    const effort = firstString(meta.effort, meta.reasoning, meta.thinkingLevel);
    const modelId = firstString(meta.model);
    const permissionMode = firstString(meta.permissionMode);
    const providerId = firstString(meta.modelProviderId, meta.providerId);
    return {
        ...(effort === undefined ? {} : { effort }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(providerId === undefined ? {} : { providerId }),
    };
}

function firstString(...values: readonly unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === "string");
}
