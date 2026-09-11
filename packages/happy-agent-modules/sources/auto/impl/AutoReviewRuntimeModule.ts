import type {
    AgentBaseInference,
    AgentBasePersistedEvent,
    AgentBaseToolOutcome,
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
} from "@slopus/happy-agent-base";
import type {
    SessionDoneState,
    SessionEvent,
    SessionOutputBlock,
    SessionUsage,
} from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import type {
    PermissionReviewTranscript,
    PermissionReviewTranscriptEntry,
} from "../../permissions/PermissionReviewer.js";
import { PERMISSION_REVIEW_INSTRUCTIONS } from "./createPermissionReviewInstructions.js";
import { boundReviewTranscript } from "./boundReviewTranscript.js";

/**
 * The private review system's runtime module: it supplies the current guardian instructions to the
 * reviewer and captures exactly what one review did.
 *
 * One instance serves the whole private collection, so everything it holds is keyed by the reviewer
 * agent's ID. Before each review `AutoModule` sets that reviewer's instructions — the guardian
 * policy with the reread security files, followed by the reread project instructions — and clears
 * its capture. The reviewer then runs one send to settlement; the module records the reviewer's own
 * reasoning, text, tool calls, and tool results, sums its provider usage before anything is
 * bounded, and remembers how the run ended. When the send settles `AutoModule` takes the capture
 * and turns it into the bounded `PermissionReviewTranscript` a decision carries.
 *
 * Capture is process-memory rather than durable, and that is deliberate. The specification asked
 * for a durable capture, but the only durable state a review actually needs across a restart is its
 * cursor, which `AutoModule` persists in the private store. A review interrupted by a crash is
 * discarded and rebuilt from the whole transcript exactly as an unfinished review is — so a
 * transcript that did not survive the crash is a transcript for a review that no longer exists. The
 * observable delta, reset, and crash-safety behavior is identical; only an unused durable copy of a
 * discarded review's reasoning is not written.
 */

/** What one settled review produced, before bounding, keyed to the reviewer that produced it. */
export interface AutoReviewCapture {
    /** The reviewer's own entries, in order, only for the current review. */
    readonly entries: readonly PermissionReviewTranscriptEntry[];
    /** The summed provider usage for this review. */
    readonly usage: SessionUsage;
    /** Whether any inference ran this review. */
    readonly inferred: boolean;
    /** How the reviewer's run ended: `"normal"` is a completed verdict, anything else is not. */
    readonly doneState: SessionDoneState | undefined;
    /** The provider's human-readable failure, not a permission judgement. */
    readonly errorMessage?: string;
    /** Set before sending inference, after provider/session construction has succeeded. */
    readonly inferenceStarted?: boolean;
}

interface ReviewerState {
    instructions: string;
    entries: PermissionReviewTranscriptEntry[];
    usage: SessionUsage;
    inferred: boolean;
    doneState: SessionDoneState | undefined;
    errorMessage?: string;
    inferenceStarted?: boolean;
}

const EMPTY_USAGE: SessionUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
};

export class AutoReviewRuntimeModule implements AgentModule {
    readonly name = "autoReviewRuntime";

    /** Per-reviewer instructions and capture, keyed by the reviewer agent's ID. */
    readonly #state = new Map<string, ReviewerState>();

    /**
     * Set the instructions for one reviewer's next review and clear its capture. `AutoModule` calls
     * this immediately before the send, so the reviewer runs on the freshly reread policy and the
     * capture holds only this review's work.
     */
    beginReview(reviewerAgentId: string, instructions: string): void {
        this.#state.set(reviewerAgentId, {
            instructions,
            entries: [],
            usage: { ...EMPTY_USAGE },
            inferred: false,
            doneState: undefined,
        });
    }

    /**
     * Take and clear one reviewer's capture after its send has settled.
     *
     * Clearing is what makes a capture belong to exactly one review: a second read must find
     * nothing, so a retry or a stray caller cannot attribute one review's reasoning, tool calls, and
     * token usage to another review that never did that work. The reviewer itself is kept — its
     * instructions must survive, and a hook that settles after the capture was taken still belongs
     * to it — so the capture is reset in place rather than forgotten.
     */
    takeCapture(reviewerAgentId: string): AutoReviewCapture {
        const state = this.#state.get(reviewerAgentId);
        if (state === undefined) {
            return {
                entries: [],
                usage: { ...EMPTY_USAGE },
                inferred: false,
                doneState: undefined,
            };
        }
        const capture = {
            entries: state.entries,
            usage: state.usage,
            inferred: state.inferred,
            doneState: state.doneState,
            ...(state.errorMessage === undefined ? {} : { errorMessage: state.errorMessage }),
            ...(state.inferenceStarted === undefined
                ? {}
                : { inferenceStarted: state.inferenceStarted }),
        };
        // Fresh containers, so the capture just returned is never mutated behind its holder.
        state.entries = [];
        state.usage = { ...EMPTY_USAGE };
        state.inferred = false;
        state.doneState = undefined;
        delete state.errorMessage;
        delete state.inferenceStarted;
        return capture;
    }

    /** Bound this reviewer's capture into the transcript a decision carries. */
    boundTranscript(
        reviewerAgentId: string,
        modelId: string,
        providerId: string,
    ): PermissionReviewTranscript | undefined {
        const capture = this.takeCapture(reviewerAgentId);
        return boundReviewTranscript({
            entries: capture.entries,
            usage: capture.usage,
            inferred: capture.inferred,
            modelId,
            providerId,
        });
    }

    readonly #hooks: AgentModuleHooks = {
        beforeInference: (_ctx: Context, scope: AgentModuleScope): void => {
            const state = this.#state.get(scope.agent.id);
            if (state === undefined) return;
            state.inferenceStarted = true;
            state.doneState = undefined;
            delete state.errorMessage;
        },

        instructions: (_ctx: Context, scope: AgentModuleScope): string =>
            this.#state.get(scope.agent.id)?.instructions ?? PERMISSION_REVIEW_INSTRUCTIONS,

        /** Capture the reviewer's own completed reasoning, text, and tool-call blocks. */
        onEventTransact: (
            _ctx: Context,
            scope: AgentModuleScope,
            event: AgentBasePersistedEvent,
        ): void => {
            const state = this.#state.get(scope.agent.id);
            if (state === undefined) return;
            if (event.type === "text_end") {
                state.entries.push({ type: "text", text: event.block.text });
            } else if (event.type === "reasoning_end") {
                state.entries.push({ type: "thinking", text: event.block.text ?? "" });
            } else if (event.type === "toolcall_end") {
                state.entries.push({
                    type: "tool_call",
                    name: event.block.name,
                    arguments: event.block.arguments,
                });
            }
        },

        /** Capture the result of each read-only tool call the reviewer made. */
        afterToolCall: (
            _ctx: Context,
            scope: AgentModuleScope,
            outcome: AgentBaseToolOutcome,
        ): void => {
            const state = this.#state.get(scope.agent.id);
            if (state === undefined) return;
            state.entries.push({
                type: "tool_result",
                name: toolName(outcome.tool),
                isError: outcome.isError,
                text: renderContent(outcome.content),
            });
        },

        /** Sum provider usage and remember how the run ended, both taken before any bounding. */
        onEvent: (_ctx: Context, scope: AgentModuleScope, event: SessionEvent): void => {
            const state = this.#state.get(scope.agent.id);
            if (state === undefined) return;
            if (event.type === "token_usage") {
                state.usage = addUsage(state.usage, event.usage);
                state.inferred = true;
            } else if (event.type === "done") {
                state.doneState = event.state;
                if (event.state === "error") state.errorMessage = event.message;
                else delete state.errorMessage;
            }
        },

        /** A done event without token usage still marks that an inference ran. */
        afterInference: (
            _ctx: Context,
            scope: AgentModuleScope,
            inference: AgentBaseInference,
        ): void => {
            const state = this.#state.get(scope.agent.id);
            if (state === undefined) return;
            state.inferred = true;
            if (inference.state !== undefined) state.doneState = inference.state;
            if (inference.errorMessage !== undefined) state.errorMessage = inference.errorMessage;
        },
    };

    readonly beforeStart = (): AgentModuleHooks => this.#hooks;
}

function addUsage(total: SessionUsage, next: SessionUsage): SessionUsage {
    return {
        input: total.input + next.input,
        output: total.output + next.output,
        cacheRead: total.cacheRead + next.cacheRead,
        cacheWrite: total.cacheWrite + next.cacheWrite,
        totalTokens: total.totalTokens + next.totalTokens,
    };
}

function renderContent(content: readonly SessionOutputBlock[]): string {
    return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function toolName(tool: { readonly name: string; readonly namespace?: string }): string {
    return tool.namespace === undefined ? tool.name : `${tool.namespace}/${tool.name}`;
}
