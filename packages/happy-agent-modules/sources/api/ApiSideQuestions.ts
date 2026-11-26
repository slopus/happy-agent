import { randomUUID } from "node:crypto";

import type { AcpSideQuestionAnswer } from "@slopus/happy-providers";

import { ApiError } from "./ApiError.js";

/** How long one request waits for an answer: well inside every transport's 30-second limit. */
const WAIT_MS = 20_000;
/** A side question nobody collects within this long of being asked is stopped and forgotten. */
const LIFETIME_MS = 10 * 60_000;
/** The longest failure message a response carries. */
const MAX_ERROR = 2_000;

/** A side question as one response reports it. */
export type ApiSideQuestionState =
    | { readonly id: string; readonly status: "answering" }
    | {
          readonly id: string;
          readonly status: "answered";
          readonly response: string | null;
          readonly synthetic: boolean;
      }
    | { readonly id: string; readonly status: "failed"; readonly error: string };

/** What side questions need of the response a request is answered with. */
export interface ApiSideQuestionResponse {
    readonly writableFinished: boolean;
    once(event: "close" | "finish", listener: () => void): unknown;
    off(event: "close", listener: () => void): unknown;
}

type Outcome =
    | { readonly answer: AcpSideQuestionAnswer }
    | { readonly refusal: ApiError }
    | { readonly error: string };

interface Question {
    readonly agentId: string;
    /** The team member who asked, who alone may collect or cancel it; none when standalone. */
    readonly owner: string | undefined;
    readonly controller: AbortController;
    readonly outcome: Promise<Outcome>;
    readonly expiry: NodeJS.Timeout;
}

/**
 * @internal The side questions still being answered, or answered and not yet collected.
 *
 * Answering can take longer than one request may wait, so a question is asked once and collected
 * with as many requests as it needs, each waiting at most 20 seconds. A question is forgotten once
 * a response carrying its answer or failure has been sent in full (`deliver`), when it is
 * cancelled, and when nobody has collected it within 10 minutes of being asked, which also stops
 * its answer. A response whose connection failed leaves the answer for the next request, and a
 * question whose asker left before learning its id is stopped at once. So only the questions of
 * the last ten minutes are held, and only in memory: they end with the daemon.
 */
export class ApiSideQuestions {
    readonly #questions = new Map<string, Question>();
    readonly #waitMs: number;

    constructor(options: { readonly waitMs?: number } = {}) {
        this.#waitMs = options.waitMs ?? WAIT_MS;
    }

    /**
     * Start answering with `answer`, which runs on beyond this request, and wait for it. An
     * `ApiError` that `answer` throws refuses the question, and is thrown to the asker instead. A
     * client that disconnects from `response` before it is answered never learns the question's
     * id, so nobody could collect it: the question is stopped at once.
     */
    async ask(
        agentId: string,
        owner: string | undefined,
        answer: (signal: AbortSignal) => Promise<AcpSideQuestionAnswer>,
        response?: ApiSideQuestionResponse,
    ): Promise<ApiSideQuestionState> {
        const id = randomUUID();
        const controller = new AbortController();
        const expiry = setTimeout(() => this.#forget(id, true), LIFETIME_MS);
        expiry.unref?.();
        const outcome = answer(controller.signal).then(
            (answered): Outcome => ({ answer: answered }),
            (error: unknown): Outcome =>
                error instanceof ApiError ? { refusal: error } : { error: errorText(error) },
        );
        this.#questions.set(id, { agentId, owner, controller, outcome, expiry });
        const leave = (): void => {
            if (response?.writableFinished === false) this.#forget(id, true);
        };
        response?.once("close", leave);
        try {
            return (await this.#wait(id)) ?? { id, status: "failed", error: "It was stopped." };
        } finally {
            response?.off("close", leave);
        }
    }

    /** Wait again for a question asked earlier; `undefined` when it is gone or someone else's. */
    async wait(
        agentId: string,
        owner: string | undefined,
        id: string,
    ): Promise<ApiSideQuestionState | undefined> {
        if (this.#find(agentId, owner, id) === undefined) return undefined;
        return await this.#wait(id);
    }

    /** Stop answering a question and forget it; `false` when it was already gone. */
    cancel(agentId: string, owner: string | undefined, id: string): boolean {
        if (this.#find(agentId, owner, id) === undefined) return false;
        this.#forget(id, true);
        return true;
    }

    /**
     * Answer a request with where a side question stands, through `send`. One that ended is
     * forgotten only once `response` has been sent in full, so a response whose connection fails
     * leaves the answer for the next request.
     */
    deliver(
        response: ApiSideQuestionResponse,
        agentId: string,
        owner: string | undefined,
        sideQuestion: ApiSideQuestionState,
        send: () => void,
    ): void {
        if (sideQuestion.status !== "answering") {
            response.once("finish", () => {
                if (this.#find(agentId, owner, sideQuestion.id) !== undefined) {
                    this.#forget(sideQuestion.id, false);
                }
            });
        }
        send();
    }

    #find(agentId: string, owner: string | undefined, id: string): Question | undefined {
        const question = this.#questions.get(id);
        return question?.agentId === agentId && question.owner === owner ? question : undefined;
    }

    async #wait(id: string): Promise<ApiSideQuestionState | undefined> {
        const question = this.#questions.get(id);
        if (question === undefined) return undefined;
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
            question.outcome,
            new Promise<undefined>((resolve) => {
                timer = setTimeout(() => resolve(undefined), this.#waitMs);
            }),
        ]).finally(() => clearTimeout(timer));
        // Cancelled, expired, or collected by another request meanwhile.
        if (this.#questions.get(id) !== question) return undefined;
        if (outcome === undefined) return { id, status: "answering" };
        if ("refusal" in outcome) {
            this.#forget(id, false);
            throw outcome.refusal;
        }
        if ("error" in outcome) return { id, status: "failed", error: outcome.error };
        return {
            id,
            status: "answered",
            response: outcome.answer.response,
            synthetic: outcome.answer.synthetic,
        };
    }

    #forget(id: string, stop: boolean): void {
        const question = this.#questions.get(id);
        if (question === undefined) return;
        clearTimeout(question.expiry);
        this.#questions.delete(id);
        if (stop) question.controller.abort();
    }
}

function errorText(error: unknown): string {
    const text = (error instanceof Error ? error.message : String(error)).trim();
    return (text === "" ? "The harness gave no reason." : text).slice(0, MAX_ERROR);
}
