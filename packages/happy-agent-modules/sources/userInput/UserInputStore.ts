import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    userInputAgentIdSchema,
    userInputListQuerySchema,
    userInputPageSchema,
    userInputRequestIdSchema,
    userInputRequestSchema,
    userInputTimestampSchema,
    type UserInputPage,
} from "./UserInputRequest.js";
import { userInputContextSchema } from "./UserInputEvent.js";

export const userInputAuthorizationActionSchema = Type.Union([
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("wait"),
    Type.Literal("answer"),
    Type.Literal("cancel"),
    Type.Literal("complete"),
]);

/** Internal SQL adapter contract used by UserInputModule's module-owned tables. */
export const userInputStoreSchema = Type.Object(
    {
        readRequest: Type.Function(
            [userInputContextSchema, userInputRequestIdSchema],
            Type.Promise(Type.Union([userInputRequestSchema, Type.Undefined()])),
        ),
        writeRequest: Type.Function(
            [userInputContextSchema, userInputRequestSchema],
            Type.Promise(Type.Void()),
        ),
        listRequests: Type.Function(
            [userInputContextSchema, userInputAgentIdSchema, userInputListQuerySchema],
            Type.Promise(userInputPageSchema),
        ),
        latestQuestionAt: Type.Function(
            [userInputContextSchema, userInputAgentIdSchema],
            Type.Promise(Type.Union([userInputTimestampSchema, Type.Undefined()])),
        ),
    },
    { additionalProperties: false },
);

export type UserInputAuthorizationAction = Static<typeof userInputAuthorizationActionSchema>;
export type UserInputStore = Static<typeof userInputStoreSchema>;

export function assertUserInputPage(value: unknown): asserts value is UserInputPage {
    if (!Value.Check(userInputPageSchema, value)) {
        throw new Error("User input store returned an invalid request page.");
    }
}

export function assertUserInputVoidResult(value: unknown, operation: string): void {
    if (value !== undefined) {
        throw new Error(`User input ${operation} must return undefined.`);
    }
}

export function assertUserInputContext(value: unknown): asserts value is Context {
    if (!Value.Check(userInputContextSchema, value)) {
        throw new Error("User input context is invalid.");
    }
}
