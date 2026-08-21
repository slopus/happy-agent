import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** What Happy may ask this session to do. */
export const HAPPY_SESSION_RPC_METHODS = ["abort", "communication", "killSession"] as const;

const communicationSchema = Type.Object(
    {
        answers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        id: Type.String({ minLength: 1 }),
        status: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

/**
 * Carries out one thing the phone asked of this session.
 *
 * Everything here is something a person did with their thumb: stop this, answer
 * that, end the session. The answer goes back encrypted, so a failure is
 * reported as a message rather than thrown away.
 */
export async function handleHappySessionRpc(options: {
    abort: () => Promise<void>;
    answerQuestion: (requestId: string, answers: Record<string, unknown>) => Promise<void>;
    archive: () => Promise<void>;
    cancelQuestion: (requestId: string) => Promise<void>;
    method: string;
    params: unknown;
}): Promise<unknown> {
    if (options.method === "abort") {
        await options.abort();
        return { success: true };
    }
    if (options.method === "killSession") {
        await options.archive();
        return { success: true };
    }
    if (options.method === "communication") {
        if (!Value.Check(communicationSchema, options.params)) {
            return { error: "Happy sent an answer Happy Agent could not read." };
        }
        // A dismissal, including one from a phone that could not draw the form,
        // takes the question away rather than answering it with nothing.
        if (options.params.status !== "answered") {
            await options.cancelQuestion(options.params.id);
            return { success: true };
        }
        if (options.params.answers === undefined) {
            return { error: "Happy answered a question without any answers." };
        }
        await options.answerQuestion(options.params.id, options.params.answers);
        return { success: true };
    }
    return { error: "Method not found" };
}
