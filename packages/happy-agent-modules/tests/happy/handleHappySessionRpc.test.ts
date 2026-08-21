import { describe, expect, it } from "vitest";

import { handleHappySessionRpc } from "../../sources/happy/index.js";

function recorder() {
    const calls: string[] = [];
    return {
        calls,
        options: {
            abort: async () => {
                calls.push("abort");
            },
            answerQuestion: async (requestId: string, answers: Record<string, unknown>) => {
                calls.push(`answer:${requestId}:${JSON.stringify(answers)}`);
            },
            archive: async () => {
                calls.push("archive");
            },
            cancelQuestion: async (requestId: string) => {
                calls.push(`cancel:${requestId}`);
            },
        },
    };
}

describe("carrying out what the phone asked", () => {
    it("stops the agent", async () => {
        const { calls, options } = recorder();
        expect(await handleHappySessionRpc({ ...options, method: "abort", params: {} })).toEqual({
            success: true,
        });
        expect(calls).toEqual(["abort"]);
    });

    it("ends the session for the phone's kill switch", async () => {
        const { calls, options } = recorder();
        expect(
            await handleHappySessionRpc({ ...options, method: "killSession", params: {} }),
        ).toEqual({ success: true });
        expect(calls).toEqual(["archive"]);
    });

    it("records an answer", async () => {
        const { calls, options } = recorder();
        expect(
            await handleHappySessionRpc({
                ...options,
                method: "communication",
                params: {
                    answers: { "req-1": { options: ["Yes"] } },
                    id: "req-1",
                    status: "answered",
                },
            }),
        ).toEqual({ success: true });
        expect(calls).toEqual([
            `answer:req-1:${JSON.stringify({ "req-1": { options: ["Yes"] } })}`,
        ]);
    });

    it("takes the question away when the person dismissed it", async () => {
        const { calls, options } = recorder();
        expect(
            await handleHappySessionRpc({
                ...options,
                method: "communication",
                params: { id: "req-1", status: "cancelled" },
            }),
        ).toEqual({ success: true });
        expect(calls).toEqual(["cancel:req-1"]);
    });

    it("treats a phone that could not draw the form as a dismissal", async () => {
        const { calls, options } = recorder();
        await handleHappySessionRpc({
            ...options,
            method: "communication",
            params: { id: "req-1" },
        });
        expect(calls).toEqual(["cancel:req-1"]);
    });

    it("refuses an answer with nothing in it rather than answering with nothing", async () => {
        const { calls, options } = recorder();
        expect(
            await handleHappySessionRpc({
                ...options,
                method: "communication",
                params: { id: "req-1", status: "answered" },
            }),
        ).toEqual({ error: "Happy answered a question without any answers." });
        expect(calls).toEqual([]);
    });

    it("says so when it cannot read what arrived", async () => {
        const { options } = recorder();
        expect(
            await handleHappySessionRpc({
                ...options,
                method: "communication",
                params: "nonsense",
            }),
        ).toEqual({ error: "Happy sent an answer Happy Agent could not read." });
    });

    it("refuses a method it does not have", async () => {
        const { calls, options } = recorder();
        expect(await handleHappySessionRpc({ ...options, method: "readFile", params: {} })).toEqual(
            { error: "Method not found" },
        );
        expect(calls).toEqual([]);
    });
});
