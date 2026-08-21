import type { UserInputRequest } from "../userInput/index.js";

/**
 * Happy carries a question the agent asked on its own channel, apart from
 * permissions: a permission gates something the agent wants to do, while this
 * asks the person for something the agent does not know. Every Happy Agent question is
 * published as the `form` kind whatever tool asked it, so a phone that cannot
 * render one still shows it and lets the person dismiss it.
 */
const HAPPY_FORM_KIND = "form";

/** How many settled questions stay published, so a long session cannot grow this forever. */
const MAX_COMPLETED_COMMUNICATIONS = 100;

export interface HappyCommunication {
    createdAt: number;
    form: unknown;
    kind: string;
    title: string;
    toolUseId: string;
}

export interface HappyResolvedCommunication {
    answers?: Record<string, unknown>;
    communication: HappyCommunication;
    completedAt: number;
    status: "answered" | "cancelled";
}

export interface HappyAgentState {
    communications: Record<string, HappyCommunication>;
    completedCommunications: Record<string, unknown>;
}

/**
 * Remembers one settled question, and forgets the oldest once there are enough.
 *
 * Keeping recent ones is what lets a phone that was asleep settle a form that
 * was already answered somewhere else, rather than showing it as still waiting.
 */
export function rememberHappyResolvedCommunication(
    completed: Map<string, HappyResolvedCommunication>,
    requestId: string,
    resolved: HappyResolvedCommunication,
): void {
    completed.delete(requestId);
    completed.set(requestId, resolved);
    while (completed.size > MAX_COMPLETED_COMMUNICATIONS) {
        const oldest = completed.keys().next().value;
        if (oldest === undefined) return;
        completed.delete(oldest);
    }
}

/**
 * Projects the questions this agent is waiting on into Happy's live state.
 *
 * Answering nothing at all clears the remote state, which is how a phone stops
 * showing a prompt for a question that is no longer being asked.
 */
export function createHappyAgentState(options: {
    completed: ReadonlyMap<string, HappyResolvedCommunication>;
    /**
     * When a question was first published. It must not move: the caller skips
     * the round trip only when the state is byte-identical, so a timestamp that
     * changed on every tick would republish forever.
     */
    createdAt: (requestId: string) => number;
    pending: readonly UserInputRequest[];
}): HappyAgentState | null {
    const communications: Record<string, HappyCommunication> = {};
    for (const request of options.pending) {
        communications[request.id] = toHappyCommunication(request, options.createdAt(request.id));
    }

    const completedCommunications: Record<string, unknown> = {};
    for (const [requestId, resolved] of options.completed) {
        // A question being asked again outranks a stale answer to it.
        if (communications[requestId] !== undefined) continue;
        completedCommunications[requestId] = {
            ...resolved.communication,
            completedAt: resolved.completedAt,
            status: resolved.status,
            ...(resolved.answers === undefined ? {} : { answers: resolved.answers }),
        };
    }

    if (
        Object.keys(communications).length === 0 &&
        Object.keys(completedCommunications).length === 0
    ) {
        return null;
    }
    return { communications, completedCommunications };
}

/**
 * Builds the form the phone renders.
 *
 * Every question also accepts words the person writes themselves, because Happy Agent
 * takes any answer and not only the ones it thought to offer.
 */
export function toHappyCommunication(
    request: UserInputRequest,
    createdAt: number,
): HappyCommunication {
    const questions =
        request.questions ??
        ([
            {
                ...(request.header === undefined ? {} : { header: request.header }),
                id: request.id,
                ...(request.options === undefined ? {} : { options: request.options }),
                question: request.question,
            },
        ] as const);
    return {
        createdAt,
        form: {
            questions: questions.map((question) => ({
                allowCustom: true,
                header: question.header ?? "Question",
                id: question.id,
                multiSelect: question.options?.multiSelect ?? false,
                options: (question.options?.choices ?? []).map((choice) => ({
                    description: choice.description,
                    label: choice.label,
                })),
                question: question.question,
                required: true,
            })),
        },
        kind: HAPPY_FORM_KIND,
        // Shown by a phone that cannot render this kind, so the person still
        // learns what the agent is waiting on.
        title: request.header ?? request.questions?.[0]?.header ?? "Question",
        toolUseId: request.id,
    };
}
