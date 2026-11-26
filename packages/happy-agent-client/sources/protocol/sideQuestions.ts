/**
 * Side questions: a question about an agent's conversation that its harness answers without
 * adding to it, as Claude Code's `/btw` does. Served when health reports
 * `capabilities.sideQuestions`, for models whose definition carries `sideQuestions`.
 */

import { type Static, Type } from "@sinclair/typebox";

/** One earlier exchange of a side thread, sent with a follow-up so it has their context. */
export const sideQuestionTurnSchema = Type.Object(
    {
        question: Type.String({ maxLength: 100_000 }),
        response: Type.String({ maxLength: 100_000 }),
    },
    { additionalProperties: false },
);

/** `POST /v0/agents/:agentId/side-questions` request. */
export const askSideQuestionRequestSchema = Type.Object(
    {
        question: Type.String({ minLength: 1, maxLength: 100_000, pattern: "\\S" }),
        /** Earlier exchanges of the same side thread, oldest first. */
        history: Type.Optional(Type.Array(sideQuestionTurnSchema, { maxItems: 50 })),
    },
    { additionalProperties: false },
);

/** A side question as one response reports it; gone once a response carrying its end is sent. */
export const sideQuestionSchema = Type.Union([
    Type.Object({ id: Type.String({ minLength: 1 }), status: Type.Literal("answering") }),
    Type.Object({
        id: Type.String({ minLength: 1 }),
        status: Type.Literal("answered"),
        /** The answer as Markdown; `null` when the harness produced none. */
        response: Type.Union([Type.String(), Type.Null()]),
        /** The harness gave a canned reply in place of one the model could not give. */
        synthetic: Type.Boolean(),
    }),
    Type.Object({
        id: Type.String({ minLength: 1 }),
        status: Type.Literal("failed"),
        /** Why the harness gave no answer, in English for display. */
        error: Type.String(),
    }),
]);

/** Answer of the side-question `POST` and `GET`. */
export const sideQuestionResponseSchema = Type.Object({ sideQuestion: sideQuestionSchema });

/** Answer of the side-question `DELETE`; `cancelled` is `false` when it was already gone. */
export const cancelSideQuestionResponseSchema = Type.Object({ cancelled: Type.Boolean() });

export type SideQuestionTurn = Static<typeof sideQuestionTurnSchema>;
export type AskSideQuestionRequest = Static<typeof askSideQuestionRequestSchema>;
export type SideQuestion = Static<typeof sideQuestionSchema>;
export type SideQuestionResponse = Static<typeof sideQuestionResponseSchema>;
export type CancelSideQuestionResponse = Static<typeof cancelSideQuestionResponseSchema>;
