import { describe, expect, it } from "vitest";

import {
    createHappyAgentState,
    rememberHappyResolvedCommunication,
    toHappyCommunication,
    type HappyResolvedCommunication,
} from "../../sources/happy/index.js";
import type { UserInputRequest } from "../../sources/userInput/index.js";

function request(id: string, overrides: Partial<UserInputRequest> = {}): UserInputRequest {
    return {
        askingAgentId: "agent-1",
        context: "Working out what to do next.",
        createdAt: 1_000,
        id,
        question: "Which way?",
        status: "pending",
        updatedAt: 1_000,
        ...overrides,
    } as UserInputRequest;
}

function resolved(id: string): HappyResolvedCommunication {
    return {
        communication: toHappyCommunication(request(id), 1_000),
        completedAt: 2_000,
        status: "answered",
    };
}

describe("publishing what a session is waiting on", () => {
    it("says nothing at all when nothing is being asked", () => {
        expect(
            createHappyAgentState({
                completed: new Map(),
                createdAt: () => 1_000,
                pending: [],
            }),
        ).toBeNull();
    });

    it("publishes a pending question as a form the phone can draw", () => {
        const state = createHappyAgentState({
            completed: new Map(),
            createdAt: () => 1_500,
            pending: [
                request("req-1", {
                    header: "Direction",
                    options: {
                        choices: [{ description: "Go on.", label: "Left" }],
                        multiSelect: false,
                    },
                }),
            ],
        });
        expect(state?.communications["req-1"]).toEqual({
            createdAt: 1_500,
            form: {
                questions: [
                    {
                        allowCustom: true,
                        header: "Direction",
                        id: "req-1",
                        multiSelect: false,
                        options: [{ description: "Go on.", label: "Left" }],
                        question: "Which way?",
                        required: true,
                    },
                ],
            },
            kind: "form",
            title: "Direction",
            toolUseId: "req-1",
        });
    });

    it("lets a question being asked again outrank a stale answer to it", () => {
        const state = createHappyAgentState({
            completed: new Map([["req-1", resolved("req-1")]]),
            createdAt: () => 3_000,
            pending: [request("req-1")],
        });
        expect(Object.keys(state?.communications ?? {})).toEqual(["req-1"]);
        expect(state?.completedCommunications).toEqual({});
    });

    it("keeps a settled question so a phone catching up sees the answer", () => {
        const state = createHappyAgentState({
            completed: new Map([["req-1", { ...resolved("req-1"), answers: { a: 1 } }]]),
            createdAt: () => 1_000,
            pending: [],
        });
        expect(state?.completedCommunications["req-1"]).toMatchObject({
            answers: { a: 1 },
            completedAt: 2_000,
            status: "answered",
        });
    });

    it("always offers a question the person can answer in their own words", () => {
        const communication = toHappyCommunication(request("req-1"), 1_000);
        expect(communication.form).toEqual({
            questions: [
                {
                    allowCustom: true,
                    header: "Question",
                    id: "req-1",
                    multiSelect: false,
                    options: [],
                    question: "Which way?",
                    required: true,
                },
            ],
        });
    });

    it("forgets the oldest settled question rather than growing forever", () => {
        const completed = new Map<string, HappyResolvedCommunication>();
        for (let index = 0; index < 150; index += 1) {
            rememberHappyResolvedCommunication(completed, `req-${index}`, resolved(`req-${index}`));
        }
        expect(completed.size).toBe(100);
        expect(completed.has("req-0")).toBe(false);
        expect(completed.has("req-149")).toBe(true);
    });

    it("moves a question that settles twice to the back of the queue", () => {
        const completed = new Map<string, HappyResolvedCommunication>();
        rememberHappyResolvedCommunication(completed, "req-1", resolved("req-1"));
        rememberHappyResolvedCommunication(completed, "req-2", resolved("req-2"));
        rememberHappyResolvedCommunication(completed, "req-1", resolved("req-1"));
        expect([...completed.keys()]).toEqual(["req-2", "req-1"]);
    });
});
