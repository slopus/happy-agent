/** Local-first Loro documents that may synchronize through Murmur. */

import { type Static, Type } from "@sinclair/typebox";

import { cuid2Schema, mutationIdSchema, resourceVersionSchema, timestampSchema } from "./common.js";

/** The stable Murmur service identifier for every Happy CRDT service. */
export const CRDT_MURMUR_SERVICE = "crdt.loro" as const;

/** An immutable application-owned discriminator such as `todo` or `com.example.board`. */
export const crdtServiceKindSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern: "^[a-z](?:[a-z0-9._/-]{0,126}[a-z0-9])?$",
});
export type CrdtServiceKind = Static<typeof crdtServiceKindSchema>;

/** Human-readable display text, never an identifier. */
export const crdtServiceNameSchema = Type.String({
    minLength: 1,
    // One valid surrogate pair counts as one character, and lone surrogates are rejected.
    pattern:
        "^(?=[\\s\\S]*\\S)(?:(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])|[^\\uD800-\\uDFFF\\x00-\\x1f\\x7f]){1,256}$",
});
export type CrdtServiceName = Static<typeof crdtServiceNameSchema>;

const UNPADDED_BASE64URL_PATTERN =
    "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$";

/** Up to 512 KiB of decoded Loro bytes, encoded as unpadded base64url. */
export const crdtEncodedBytesSchema = Type.String({
    maxLength: 699_051,
    minLength: 2,
    pattern: UNPADDED_BASE64URL_PATTERN,
});
export type CrdtEncodedBytes = Static<typeof crdtEncodedBytesSchema>;

/** A 32-byte Murmur account or session identity encoded as unpadded base64url. */
export const crdtMurmurIdentitySchema = Type.String({
    maxLength: 43,
    minLength: 43,
    pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
});
export type CrdtMurmurIdentity = Static<typeof crdtMurmurIdentitySchema>;

/** An opaque Murmur directory capability of at most 8,192 decoded bytes. */
export const crdtMurmurTicketSchema = Type.String({
    maxLength: 10_923,
    minLength: 2,
    pattern: UNPADDED_BASE64URL_PATTERN,
});
export type CrdtMurmurTicket = Static<typeof crdtMurmurTicketSchema>;

/** One structurally valid JSON value produced by Loro's document projection. */
export const crdtJsonValueSchema = Type.Recursive(
    (value) =>
        Type.Union([
            Type.String(),
            Type.Number(),
            Type.Boolean(),
            Type.Null(),
            Type.Array(value),
            Type.Record(Type.String(), value),
        ]),
    { $id: "HappyAgentCrdtJsonValueV1" },
);
export type CrdtJsonValue = Static<typeof crdtJsonValueSchema>;

const CRDT_TREE_MAX_BYTES = 4 * 1024 * 1024;
const CRDT_TREE_MAX_DEPTH = 64;
const CRDT_TREE_MAX_VALUES = 100_000;
const CRDT_TREE_MAX_ENTRIES = 100_000;
const CRDT_TREE_MAX_STRING_BYTES = 1024 * 1024;
const utf8Encoder = new TextEncoder();

function utf8Length(value: string): number {
    return utf8Encoder.encode(value).byteLength;
}

function jsonStringLength(value: string): number {
    return utf8Length(JSON.stringify(value));
}

export const crdtTreeLimitViolationSchema = Type.Union([
    Type.Literal("depth"),
    Type.Literal("entries"),
    Type.Literal("invalid_value"),
    Type.Literal("serialized_size"),
    Type.Literal("string_size"),
    Type.Literal("total_values"),
]);
export type CrdtTreeLimitViolation = Static<typeof crdtTreeLimitViolationSchema>;

type JsonTraversal =
    | { depth: number; type: "value"; value: unknown }
    | { type: "leave"; value: object };

/** Returns the first operational limit violated by a structurally valid CRDT tree. */
export function getCrdtTreeLimitViolation(root: CrdtTree): CrdtTreeLimitViolation | null {
    const stack: JsonTraversal[] = [{ depth: 1, type: "value", value: root }];
    const activeContainers = new WeakSet<object>();

    let serializedBytes = 0;
    let totalValues = 0;

    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.type === "leave") {
            activeContainers.delete(current.value);
            continue;
        }

        totalValues += 1;
        if (totalValues > CRDT_TREE_MAX_VALUES) return "total_values";

        const value = current.value;
        if (value === null) {
            serializedBytes += 4;
        } else if (typeof value === "string") {
            if (utf8Length(value) > CRDT_TREE_MAX_STRING_BYTES) return "string_size";
            serializedBytes += jsonStringLength(value);
        } else if (typeof value === "number") {
            if (!Number.isFinite(value)) return "invalid_value";
            serializedBytes += utf8Length(JSON.stringify(value));
        } else if (typeof value === "boolean") {
            serializedBytes += value ? 4 : 5;
        } else if (Array.isArray(value)) {
            if (current.depth > CRDT_TREE_MAX_DEPTH) return "depth";
            if (value.length > CRDT_TREE_MAX_ENTRIES) return "entries";
            if (Object.keys(value).length !== value.length) return "invalid_value";
            if (activeContainers.has(value)) return "invalid_value";
            activeContainers.add(value);
            stack.push({ type: "leave", value });
            serializedBytes += 2 + Math.max(0, value.length - 1);
            for (let index = value.length - 1; index >= 0; index -= 1) {
                if (!Object.hasOwn(value, index)) return "invalid_value";
                stack.push({ depth: current.depth + 1, type: "value", value: value[index] });
            }
        } else if (typeof value === "object") {
            const record = value as Record<string, unknown>;
            const keys = Object.keys(record);
            const prototype = Object.getPrototypeOf(record);
            if (current.depth > CRDT_TREE_MAX_DEPTH) return "depth";
            if (keys.length > CRDT_TREE_MAX_ENTRIES) return "entries";
            if (prototype !== Object.prototype && prototype !== null) return "invalid_value";
            if (
                Object.getOwnPropertySymbols(record).some((symbol) =>
                    Object.prototype.propertyIsEnumerable.call(record, symbol),
                )
            )
                return "invalid_value";
            if (activeContainers.has(record)) return "invalid_value";
            activeContainers.add(record);
            stack.push({ type: "leave", value: record });
            serializedBytes += 2 + Math.max(0, keys.length - 1);
            for (let index = keys.length - 1; index >= 0; index -= 1) {
                const key = keys[index]!;
                if (utf8Length(key) > CRDT_TREE_MAX_STRING_BYTES) return "string_size";
                serializedBytes += jsonStringLength(key) + 1;
                stack.push({ depth: current.depth + 1, type: "value", value: record[key] });
            }
        } else {
            return "invalid_value";
        }

        if (serializedBytes > CRDT_TREE_MAX_BYTES) return "serialized_size";
    }

    return null;
}

/** The top-level JSON object produced by a Loro document. */
export const crdtTreeSchema = Type.Record(Type.String(), crdtJsonValueSchema);
export type CrdtTree = Static<typeof crdtTreeSchema>;

/** An account-level participant; devices are not participants. */
export const crdtParticipantSchema = Type.Object({
    identityKey: crdtMurmurIdentitySchema,
    role: Type.Union([Type.Literal("owner"), Type.Literal("admin"), Type.Literal("member")]),
});
export type CrdtParticipant = Static<typeof crdtParticipantSchema>;

/** The complete confirmed Murmur policy snapshot. */
export const crdtPoliciesSchema = Type.Object({
    adminsAssignAdmins: Type.Boolean(),
    anyoneCanAddMembers: Type.Boolean(),
    sendPolicy: Type.Union([Type.Literal("everyone"), Type.Literal("admins")]),
});
export type CrdtPolicies = Static<typeof crdtPoliciesSchema>;

/** This service remains entirely local even when Murmur is online. */
export const crdtLocalSharingSchema = Type.Object({ status: Type.Literal("local") });
export type CrdtLocalSharing = Static<typeof crdtLocalSharingSchema>;

/** This service has one encrypted Murmur sharing relationship. */
export const crdtSharedSharingSchema = Type.Object({
    owner: crdtMurmurIdentitySchema,
    participants: Type.Array(crdtParticipantSchema, { maxItems: 256, minItems: 1 }),
    policies: crdtPoliciesSchema,
    recovery: Type.Union([Type.Literal("ready"), Type.Literal("required")]),
    sessionId: crdtMurmurIdentitySchema,
    status: Type.Literal("shared"),
});
export type CrdtSharedSharing = Static<typeof crdtSharedSharingSchema>;

export const crdtSharedSharingViolationSchema = Type.Union([
    Type.Literal("owner"),
    Type.Literal("participants"),
]);
export type CrdtSharedSharingViolation = Static<typeof crdtSharedSharingViolationSchema>;

/** Checks participant ordering and the cross-field owner invariant. */
export function getCrdtSharedSharingViolation(
    value: CrdtSharedSharing,
): CrdtSharedSharingViolation | null {
    let previousIdentity: string | undefined;
    let ownerCount = 0;
    for (const participant of value.participants) {
        if (previousIdentity !== undefined && previousIdentity >= participant.identityKey) {
            return "participants";
        }
        previousIdentity = participant.identityKey;

        const isOwner = participant.identityKey === value.owner;
        if (isOwner) ownerCount += 1;
        if (isOwner !== (participant.role === "owner")) return "owner";
    }
    return ownerCount === 1 ? null : "owner";
}

export const crdtSharingSchema = Type.Union([crdtLocalSharingSchema, crdtSharedSharingSchema]);
export type CrdtSharing = Static<typeof crdtSharingSchema>;

/** The bounded metadata used by catalogs and creation events. */
export const crdtServiceSummarySchema = Type.Object({
    createdAt: timestampSchema,
    id: cuid2Schema,
    kind: crdtServiceKindSchema,
    name: crdtServiceNameSchema,
    service: Type.Literal(CRDT_MURMUR_SERVICE),
    sharing: crdtSharingSchema,
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type CrdtServiceSummary = Static<typeof crdtServiceSummarySchema>;

/** A complete focused service, including its canonical Loro snapshot and JSON projection. */
export const crdtServiceSchema = Type.Composite([
    crdtServiceSummarySchema,
    Type.Object({ state: crdtEncodedBytesSchema, tree: crdtTreeSchema }),
]);
export type CrdtService = Static<typeof crdtServiceSchema>;

/** `GET /v0/services/crdt` query parameters. */
export const crdtServiceListQuerySchema = Type.Object(
    {
        after: Type.Optional(cuid2Schema),
        kind: Type.Optional(crdtServiceKindSchema),
        limit: Type.Optional(Type.Integer({ maximum: 500, minimum: 1 })),
    },
    { additionalProperties: false },
);
export type CrdtServiceListQuery = Static<typeof crdtServiceListQuerySchema>;

/** `GET /v0/services/crdt` */
export const crdtServiceListResponseSchema = Type.Object({
    connection: Type.Union([Type.Literal("offline"), Type.Literal("online")]),
    cursor: Type.Union([cuid2Schema, Type.Null()]),
    hasMore: Type.Boolean(),
    services: Type.Array(crdtServiceSummarySchema, { maxItems: 500 }),
    updatedAt: timestampSchema,
    version: resourceVersionSchema,
});
export type CrdtServiceListResponse = Static<typeof crdtServiceListResponseSchema>;

/** The response shared by focused CRDT service reads and mutations. */
export const crdtServiceResponseSchema = Type.Object({ service: crdtServiceSchema });
export type CrdtServiceResponse = Static<typeof crdtServiceResponseSchema>;

/** Client result for creation, including the meaningful new-versus-retry status. */
export const createCrdtServiceResultSchema = Type.Composite([
    crdtServiceResponseSchema,
    Type.Object({ httpStatus: Type.Union([Type.Literal(200), Type.Literal(201)]) }),
]);
export type CreateCrdtServiceResult = Static<typeof createCrdtServiceResultSchema>;

/** Client result for membership mutations, including accepted-versus-no-op status. */
export const crdtServiceMemberMutationResultSchema = Type.Composite([
    crdtServiceResponseSchema,
    Type.Object({ httpStatus: Type.Union([Type.Literal(200), Type.Literal(202)]) }),
]);
export type CrdtServiceMemberMutationResult = Static<typeof crdtServiceMemberMutationResultSchema>;

/** `POST /v0/services/crdt` */
export const createCrdtServiceRequestSchema = Type.Object(
    {
        id: Type.Optional(cuid2Schema),
        kind: crdtServiceKindSchema,
        mutationId: Type.Optional(mutationIdSchema),
        name: crdtServiceNameSchema,
        state: crdtEncodedBytesSchema,
    },
    { additionalProperties: false },
);
export type CreateCrdtServiceRequest = Static<typeof createCrdtServiceRequestSchema>;

/** `POST /v0/services/crdt/:serviceId/updates` */
export const updateCrdtServiceRequestSchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        update: crdtEncodedBytesSchema,
    },
    { additionalProperties: false },
);
export type UpdateCrdtServiceRequest = Static<typeof updateCrdtServiceRequestSchema>;

/** `PUT /v0/services/crdt/:serviceId/members/:identityKey` */
export const addCrdtServiceMemberRequestSchema = Type.Object(
    {
        mutationId: Type.Optional(mutationIdSchema),
        ticket: Type.Optional(crdtMurmurTicketSchema),
    },
    { additionalProperties: false },
);
export type AddCrdtServiceMemberRequest = Static<typeof addCrdtServiceMemberRequestSchema>;

/** `DELETE /v0/services/crdt/:serviceId/members/:identityKey` */
export const removeCrdtServiceMemberRequestSchema = Type.Object(
    { mutationId: Type.Optional(mutationIdSchema) },
    { additionalProperties: false },
);
export type RemoveCrdtServiceMemberRequest = Static<typeof removeCrdtServiceMemberRequestSchema>;
