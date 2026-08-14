import type { AgentPersistence } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/*
 * AgentStorage is a class in Agent Base, but a feature only needs its public
 * storage surface. Keeping this contract structural lets hosts provide an
 * equivalent adapter without making the feature depend on a concrete storage
 * implementation. The methods are still part of the runtime schema so a
 * malformed injected service is rejected at construction time.
 */
const opaqueContextSchema = Type.Any();
const unknownPromiseSchema = Type.Promise(Type.Unknown());
const persistenceEntrySchema = Type.Object(
    {
        key: Type.String({ minLength: 1 }),
        value: Type.Unknown(),
    },
    { additionalProperties: false },
);
const persistenceEntriesSchema = Type.Array(persistenceEntrySchema);
const persistenceWorkSchema = Type.Function([opaqueContextSchema], unknownPromiseSchema);
const persistenceAppendSchema = Type.Function(
    [opaqueContextSchema, Type.Unknown()],
    Type.Promise(Type.Void()),
);

/**
 * The concrete persistence surface consumed by AgentKV.
 *
 * `AgentKV` only calls the four key/value methods below, but the returned
 * object is also passed to Agent Base's `AgentKV` constructor, so validate the
 * complete AgentPersistence contract at this boundary. In particular, the
 * persistence factory's return value is checked at runtime before it is used;
 * validating the factory function itself is not enough.
 */
export const taskPersistenceSchema = Type.Unsafe<AgentPersistence>(
    Type.Object(
        {
            transaction: Type.Function(
                [opaqueContextSchema, persistenceWorkSchema],
                unknownPromiseSchema,
            ),
            load: Type.Function([opaqueContextSchema], Type.Promise(Type.Array(Type.Unknown()))),
            append: persistenceAppendSchema,
            clearRecords: Type.Function([opaqueContextSchema], Type.Promise(Type.Void())),
            readValues: Type.Function(
                [opaqueContextSchema, Type.String()],
                Type.Promise(persistenceEntriesSchema),
            ),
            writeValue: Type.Function(
                [opaqueContextSchema, Type.String(), Type.Unknown()],
                Type.Promise(Type.Void()),
            ),
            writeValueIfAbsent: Type.Function(
                [opaqueContextSchema, Type.String(), Type.Unknown()],
                Type.Promise(Type.Boolean()),
            ),
            deleteValue: Type.Function(
                [opaqueContextSchema, Type.String()],
                Type.Promise(Type.Void()),
            ),
        },
        { additionalProperties: true },
    ),
);

export type TaskPersistence = Static<typeof taskPersistenceSchema>;

export const taskStorageSchema = Type.Object(
    {
        persistence: Type.Function(
            [Type.String({ minLength: 1, maxLength: 256 })],
            taskPersistenceSchema,
        ),
    },
    { additionalProperties: false },
);

export type TaskStorage = Static<typeof taskStorageSchema>;

/**
 * Validate a persistence returned by the host's storage factory before handing it to AgentKV.
 * Class-backed persistence implementations keep their methods on the prototype, so validation
 * runs against a plain method view while the original object is retained for AgentKV.
 */
export function assertTaskPersistence(value: unknown): asserts value is AgentPersistence {
    if (!Value.Check(taskPersistenceSchema, value)) {
        throw new Error("Tasks storage returned an invalid agent persistence.");
    }
}
