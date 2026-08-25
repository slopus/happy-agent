import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    MAX_USER_INPUT_AGENT_ID_LENGTH,
    MAX_USER_INPUT_ANSWER_CHARACTERS,
    MAX_USER_INPUT_AUTO_RESOLUTION_MS,
    MAX_USER_INPUT_CONTEXT_CHARACTERS,
    MAX_USER_INPUT_CURSOR_LENGTH,
    MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS,
    MAX_USER_INPUT_HEADER_CHARACTERS,
    MAX_USER_INPUT_QUESTION_CHARACTERS,
    MIN_USER_INPUT_AUTO_RESOLUTION_MS,
    UserInputModule,
    assertUserInputAnswer,
    assertUserInputBatchAnswers,
    assertUserInputOptions,
    assertUserInputRequest,
    cancelAskTool,
    formatDetailPageForModel,
    formatForModel,
    formatPageForModel,
    readUserInputTool,
    requestUserInputTool,
    userInputAnswerObjectSchema,
    userInputAnswerSchema,
    userInputAskInputSchema,
    userInputBatchQuestionInputsSchema,
    userInputCancelInputSchema,
    userInputCompleteInputSchema,
    userInputDetailQuerySchema,
    userInputEventSchema,
    userInputListQuerySchema,
    MAX_USER_INPUT_OUTPUT_CHARACTERS,
    MAX_USER_INPUT_PAGE_SIZE,
    userInputRequestSchema,
    userInputTerminalRequestSchema,
    type UserInputRequest,
} from "../../sources/userInput/index.js";
import { createPresenceModule, createUserInputModule } from "./userInputTestSupport.js";

const agentId = "agent-one";

function pendingRequest(overrides: Partial<UserInputRequest> = {}): UserInputRequest {
    return {
        id: "request-one",
        askingAgentId: agentId,
        question: "Which option?",
        context: "Choose carefully.",
        status: "pending",
        createdAt: 10,
        updatedAt: 10,
        ...overrides,
    } as UserInputRequest;
}

function terminalAnswered(overrides: Partial<UserInputRequest> = {}): UserInputRequest {
    return {
        ...pendingRequest(),
        status: "answered",
        answer: "The first option.",
        answeredAt: 20,
        updatedAt: 20,
        ...overrides,
    } as UserInputRequest;
}

describe("UserInput runtime schemas and contracts", () => {
    it("keeps every public input schema closed and enforces boundary values", () => {
        expect(
            Value.Check(userInputAskInputSchema, {
                question: "Question",
                context: "Context",
                unknown: true,
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputBatchQuestionInputsSchema, [{ question: "One", unknown: true }]),
        ).toBe(false);
        expect(
            Value.Check(userInputCancelInputSchema, {
                requestId: "request-one",
                reason: "No longer needed.",
                extra: "closed",
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputCompleteInputSchema, {
                requestId: "request-one",
                outcome: "away",
                reason: "not allowed",
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputListQuerySchema, {
                limit: 0,
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputListQuerySchema, {
                cursor: "0".repeat(MAX_USER_INPUT_CURSOR_LENGTH + 1),
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputDetailQuerySchema, {
                limit: MAX_USER_INPUT_DETAIL_PAGE_CHARACTERS + 1,
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputRequestSchema, {
                ...pendingRequest(),
                id: "",
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputRequestSchema, {
                ...pendingRequest(),
                askingAgentId: "a".repeat(MAX_USER_INPUT_AGENT_ID_LENGTH + 1),
            }),
        ).toBe(false);
    });

    it("enforces answer shape and answer-selection semantics", () => {
        expect(Value.Check(userInputAnswerSchema, "free form")).toBe(true);
        expect(
            Value.Check(userInputAnswerObjectSchema, {
                selectedOptions: ["A"],
            }),
        ).toBe(true);
        expect(Value.Check(userInputAnswerObjectSchema, {})).toBe(false);
        expect(
            Value.Check(userInputAnswerSchema, {
                text: "",
            }),
        ).toBe(false);

        const options = {
            choices: [
                { label: "A", description: "First" },
                { label: "B", description: "Second" },
            ],
            multiSelect: false,
        } as const;
        expect(() => assertUserInputOptions(options as never)).not.toThrow();
        expect(() =>
            assertUserInputOptions({
                choices: [
                    { label: "A", description: "First" },
                    { label: "A", description: "Duplicate" },
                ],
                multiSelect: false,
            }),
        ).toThrow("unique labels");
        expect(() =>
            assertUserInputAnswer({ selectedOptions: ["A"] }, options as never),
        ).not.toThrow();
        expect(() =>
            assertUserInputAnswer({ selectedOptions: ["A", "B"] }, options as never),
        ).toThrow("only one");
        expect(() =>
            assertUserInputAnswer({ selectedOptions: ["A", "A"] }, {
                ...options,
                multiSelect: true,
            } as never),
        ).toThrow("twice");
        expect(() =>
            assertUserInputAnswer({ selectedOptions: ["C"] }, {
                ...options,
                multiSelect: true,
            } as never),
        ).toThrow("undeclared");
    });

    it("requires complete batch answers and rejects unknown question IDs", () => {
        const questions = [
            {
                id: "scope",
                question: "Scope?",
                options: {
                    choices: [{ label: "Small", description: "Safer" }],
                    multiSelect: false,
                },
            },
            {
                id: "rollout",
                question: "Roll out?",
            },
        ] as const;
        expect(() =>
            assertUserInputBatchAnswers(
                {
                    scope: "Small",
                },
                questions as never,
            ),
        ).toThrow("every question");
        expect(() =>
            assertUserInputBatchAnswers(
                {
                    scope: "Small",
                    rollout: "Yes",
                    extra: "Unexpected",
                },
                questions as never,
            ),
        ).toThrow("every question");
        expect(() =>
            assertUserInputBatchAnswers(
                {
                    scope: "Small",
                    unknown: "Yes",
                },
                questions as never,
            ),
        ).toThrow("unknown question");
        expect(() =>
            assertUserInputBatchAnswers(
                {
                    scope: { selectedOptions: ["Large"] },
                    rollout: "Yes",
                },
                questions as never,
            ),
        ).toThrow("undeclared");
        expect(() =>
            assertUserInputBatchAnswers(
                {
                    scope: "Small",
                    rollout: "Yes",
                },
                questions as never,
            ),
        ).not.toThrow();
    });

    it("validates persisted request invariants beyond TypeBox shape", () => {
        expect(() => assertUserInputRequest(pendingRequest({ updatedAt: 9 }))).toThrow(
            "timestamps are out of order",
        );
        expect(() => assertUserInputRequest(pendingRequest({ deadlineAt: 9 }))).toThrow(
            "deadline precedes",
        );
        expect(() =>
            assertUserInputRequest(
                pendingRequest({
                    questions: [
                        { id: "one", question: "One" },
                        { id: "two", question: "Two" },
                    ],
                }),
            ),
        ).toThrow("primary question disagrees");
        expect(() =>
            assertUserInputRequest({
                ...pendingRequest({
                    questions: [
                        { id: "one", question: "One" },
                        { id: "two", question: "Two" },
                    ],
                    question: "One",
                }),
                status: "answered",
                answer: "One",
                answeredAt: 20,
            } as UserInputRequest),
        ).toThrow("batch user input request");
    });

    it.fails("rejects a terminal timestamp that is newer than updatedAt", () => {
        expect(() =>
            assertUserInputRequest(
                terminalAnswered({
                    answeredAt: 30,
                    updatedAt: 20,
                }),
            ),
        ).toThrow("updatedAt");
    });

    it("validates event discriminants and terminal payloads", () => {
        const pending = pendingRequest();
        const answered = terminalAnswered();
        expect(
            Value.Check(userInputEventSchema, {
                eventId: "event-one",
                at: 20,
                actingAgentId: agentId,
                requestId: pending.id,
                type: "user_input_requested",
                request: pending,
            }),
        ).toBe(true);
        expect(
            Value.Check(userInputEventSchema, {
                eventId: "event-two",
                at: 30,
                actingAgentId: agentId,
                requestId: answered.id,
                type: "user_input_answered",
                request: answered,
            }),
        ).toBe(true);
        expect(
            Value.Check(userInputEventSchema, {
                eventId: "event-three",
                at: 30,
                actingAgentId: agentId,
                requestId: pending.id,
                type: "user_input_answered",
                request: pending,
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputEventSchema, {
                eventId: "event-four",
                at: 30,
                actingAgentId: agentId,
                requestId: pending.id,
                type: "user_input_requested",
                request: pending,
                extra: true,
            }),
        ).toBe(false);
        expect(Value.Check(userInputTerminalRequestSchema, pending)).toBe(false);
        expect(Value.Check(userInputTerminalRequestSchema, answered)).toBe(true);
    });

    it("takes the presence module and nothing else", () => {
        const presence = createPresenceModule();
        const module = new UserInputModule(presence);

        expect(module.name).toBe("userInput");
        expect(UserInputModule.length).toBe(1);
        expect(MAX_USER_INPUT_PAGE_SIZE).toBe(50);
        expect(MAX_USER_INPUT_OUTPUT_CHARACTERS).toBe(8_000);
    });

    it("keeps auto-resolution values within the documented minute-to-four-minute window", () => {
        expect(
            Value.Check(userInputAskInputSchema, {
                question: "Question",
                context: "Context",
                autoResolutionMs: MIN_USER_INPUT_AUTO_RESOLUTION_MS,
            }),
        ).toBe(true);
        expect(
            Value.Check(userInputAskInputSchema, {
                question: "Question",
                context: "Context",
                autoResolutionMs: MAX_USER_INPUT_AUTO_RESOLUTION_MS,
            }),
        ).toBe(true);
        expect(
            Value.Check(userInputAskInputSchema, {
                question: "Question",
                context: "Context",
                autoResolutionMs: MIN_USER_INPUT_AUTO_RESOLUTION_MS - 1,
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputAskInputSchema, {
                question: "Question",
                context: "Context",
                autoResolutionMs: MAX_USER_INPUT_AUTO_RESOLUTION_MS + 1,
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputAskInputSchema, {
                question: "x".repeat(MAX_USER_INPUT_QUESTION_CHARACTERS + 1),
                context: "Context",
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputAskInputSchema, {
                question: "Question",
                context: "x".repeat(MAX_USER_INPUT_CONTEXT_CHARACTERS + 1),
            }),
        ).toBe(false);
        expect(
            Value.Check(userInputAnswerSchema, "x".repeat(MAX_USER_INPUT_ANSWER_CHARACTERS + 1)),
        ).toBe(false);
    });

    it("exposes flat request and read tools with closed parameters and no Auto review", () => {
        const module = createUserInputModule();
        const requestTool = requestUserInputTool(module, agentId);
        const readTool = readUserInputTool(module, agentId);
        const cancelTool = cancelAskTool(module, agentId);

        expect(requestTool).toMatchObject({
            name: "request_user_input",
            durable: true,
            reloadable: true,
        });
        expect(readTool).toMatchObject({
            name: "read_user_input",
            durable: true,
            reloadable: true,
        });
        expect(cancelTool).toMatchObject({
            name: "cancel_ask",
            durable: false,
        });
        expect(requestTool.shouldReviewInAutoMode({} as never, {} as never)).toBe(false);
        expect(readTool.shouldReviewInAutoMode({} as never, {} as never)).toBe(false);
        expect(cancelTool.shouldReviewInAutoMode({} as never, {} as never)).toBe(false);
        if (
            requestTool.parameters === undefined ||
            readTool.parameters === undefined ||
            cancelTool.parameters === undefined
        ) {
            throw new Error("User input tools must expose parameter schemas.");
        }
        expect(
            Value.Check(requestTool.parameters, {
                context: "Context",
                questions: [{ question: "Question", header: "Release scope" }],
            }),
        ).toBe(true);
        expect(
            Value.Check(requestTool.parameters, {
                input: {
                    context: "Context",
                    questions: [{ question: "Question" }],
                },
            }),
        ).toBe(false);
        expect(MAX_USER_INPUT_HEADER_CHARACTERS).toBe(64);
        expect(
            Value.Check(requestTool.parameters, {
                context: "Context",
                questions: [
                    {
                        question: "Question",
                        header: "x".repeat(MAX_USER_INPUT_HEADER_CHARACTERS + 1),
                    },
                ],
            }),
        ).toBe(false);
        expect(
            Value.Check(requestTool.parameters, {
                context: "Context",
                questions: [{ question: "Question" }],
                deadlineAt: Date.now() + 60_000,
            }),
        ).toBe(false);
        expect(
            Value.Check(requestTool.parameters, {
                context: "Context",
                questions: [{ question: "Question" }],
                autoResolutionMs: MIN_USER_INPUT_AUTO_RESOLUTION_MS,
            }),
        ).toBe(true);
        expect(
            Value.Check(requestTool.parameters, {
                requestId: "request-one",
                cursor: "0",
            }),
        ).toBe(false);
        expect(
            Value.Check(readTool.parameters, {
                requestId: "request-one",
                cursor: "0",
            }),
        ).toBe(true);
        expect(
            Value.Check(readTool.parameters, {
                requestId: "request-one",
                unknown: true,
            }),
        ).toBe(false);
        expect(
            Value.Check(cancelTool.parameters, {
                input: { requestId: "request-one" },
            }),
        ).toBe(true);
        expect(
            Value.Check(cancelTool.parameters, {
                input: { ask_id: "request-one" },
            }),
        ).toBe(true);
        expect(
            Value.Check(cancelTool.parameters, {
                input: { requestId: "request-one", ask_id: "request-one" },
            }),
        ).toBe(false);
        expect(formatForModel(pendingRequest())).toContain("Request request-one");
        expect(
            formatPageForModel({
                requests: [pendingRequest()],
                cursor: "0",
                limit: 1,
            }),
        ).toContain("Waiting for an answer");
        expect(
            formatDetailPageForModel({
                request: pendingRequest(),
                detail: "Context detail",
                cursor: 0,
                detailTotal: 14,
            }),
        ).toContain("Context detail");
    });
});
