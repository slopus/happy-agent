import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { collaborationEffortSchema } from "../../collaboration/CollaborationAgent.js";
import { MAX_WORKFLOW_AGENT_COUNT } from "../Workflow.js";
import { fromMontyValue } from "./fromMontyValue.js";
import { parseStructuredWorkflowResult } from "./parseStructuredWorkflowResult.js";
import { runMontyWithExternals } from "./runMontyWithExternals.js";
import { serializeWorkflowValue } from "./serializeWorkflowValue.js";

/** How many items one `parallel()` or `pipeline()` call may carry. */
const MAX_WORKFLOW_BATCH_ITEMS = 4_096;

const nonBlankString = Type.String({ minLength: 1, pattern: ".*\\S.*" });

const workflowAgentOptionsSchema = Type.Object(
    {
        effort: collaborationEffortSchema,
        label: Type.Optional(Type.String()),
        model: nonBlankString,
        provider: Type.Optional(nonBlankString),
        schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        service_tier: Type.Optional(Type.Literal("priority")),
    },
    { additionalProperties: false },
);

const workflowAgentRequestSchema = Type.Object(
    {
        effort: collaborationEffortSchema,
        label: Type.Optional(Type.String()),
        model: nonBlankString,
        prompt: nonBlankString,
        provider: Type.Optional(nonBlankString),
        schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        service_tier: Type.Optional(Type.Literal("priority")),
    },
    { additionalProperties: false },
);

type WorkflowAgentOptions = Static<typeof workflowAgentOptionsSchema>;
type WorkflowAgentRequest = Static<typeof workflowAgentRequestSchema>;

/** One agent the script asked for, in the terms the module starts a collaborator with. */
export interface WorkflowAgentStart {
    readonly callIndex: number;
    /** What was asked, so a run continuing this one can tell an unchanged call from a new one. */
    readonly signature: string;
    readonly title: string;
    readonly prompt: string;
    readonly model: string;
    readonly effort: Static<typeof collaborationEffortSchema>;
    readonly provider?: string;
    readonly serviceTier?: "priority";
}

/** What one completed `agent()` call produced, and what it was asked, so a resume can reuse it. */
export interface WorkflowAgentResult {
    readonly output: unknown;
    readonly signature: string;
}

/** Where a script suspended itself, which is everything a later run needs to continue it. */
export interface WorkflowScriptCheckpoint {
    readonly nextAgentCallIndex: number;
    readonly phase: string;
    readonly snapshot: Uint8Array;
}

export interface WorkflowScriptRunnerOptions {
    readonly args: unknown;
    /** Start one collaborator and resolve with what it finally said. */
    startAgent(start: WorkflowAgentStart, signal: AbortSignal): Promise<string>;
    onAgentResult(callIndex: number, result: WorkflowAgentResult): void | Promise<void>;
    onCheckpoint(checkpoint: WorkflowScriptCheckpoint): void | Promise<void>;
    onLog(message: string): void;
    onPhase(phase: string): void;
    readonly resumeAgentCalls: readonly (WorkflowAgentResult | undefined)[];
    readonly resumeCheckpoint?: WorkflowScriptCheckpoint;
    readonly signal: AbortSignal;
}

/**
 * Runs one workflow script and turns its `agent()`, `parallel()`, and `pipeline()` calls into real
 * collaborators.
 *
 * The script is sandboxed Python with no filesystem, shell, environment, or network of its own —
 * those capabilities live in the agents it starts, and the script only decides who does what, in
 * what order. Every external call is a suspension point: the interpreter is checkpointed and
 * unloaded before the host work begins and restored afterwards, so a model's thinking time never
 * counts against the script's own execution budget, and a stopped process leaves a run that can be
 * continued rather than one that has to start over.
 */
export class WorkflowScriptRunner {
    readonly #options: WorkflowScriptRunnerOptions;
    readonly #agentCalls: (WorkflowAgentResult | undefined)[] = [];

    #nextAgentCallIndex = 0;
    #phase = "Workflow";

    constructor(options: WorkflowScriptRunnerOptions) {
        this.#options = options;
        if (options.resumeCheckpoint !== undefined) {
            this.#agentCalls = [...options.resumeAgentCalls];
            this.#nextAgentCallIndex = options.resumeCheckpoint.nextAgentCallIndex;
            this.#phase = options.resumeCheckpoint.phase;
        }
    }

    /** Run the script to its last expression, which is the workflow's consolidated result. */
    async run(script: string): Promise<unknown> {
        const output = await runMontyWithExternals({
            code: script,
            externalFunctions: {
                agent: (prompt, options) =>
                    this.#runAgent(fromMontyValue(prompt), fromMontyValue(options)),
                log: (message) => this.#log(fromMontyValue(message)),
                parallel: (requests) => this.#runParallel(fromMontyValue(requests)),
                phase: (title) => this.#setPhase(fromMontyValue(title)),
                pipeline: (items, stages) =>
                    this.#runPipeline(fromMontyValue(items), fromMontyValue(stages)),
            },
            inputs: { args: this.#options.args },
            limits: {
                maxDurationSecs: 30,
                maxMemory: 32 * 1024 * 1024,
                maxRecursionDepth: 200,
            },
            // A print writes its text and its newline as two separate writes, and the newline is
            // not a progress note of its own.
            onPrint: (text) => {
                const note = text.trimEnd();
                if (note !== "") this.#options.onLog(note);
            },
            onSnapshot: async (snapshot) =>
                await this.#options.onCheckpoint({
                    nextAgentCallIndex: this.#nextAgentCallIndex,
                    phase: this.#phase,
                    snapshot,
                }),
            signal: this.#options.signal,
            scriptName: "workflow.py",
            ...(this.#options.resumeCheckpoint === undefined
                ? {}
                : { snapshot: this.#options.resumeCheckpoint.snapshot }),
        });
        return fromMontyValue(output);
    }

    async #runAgent(
        promptValue: unknown,
        optionsValue: unknown,
        reservedCallIndex?: number,
    ): Promise<unknown> {
        if (this.#options.signal.aborted) throw new Error("The workflow was stopped.");
        if (typeof promptValue !== "string" || promptValue.trim().length === 0) {
            throw new Error("agent() requires a non-empty prompt string.");
        }
        const options = this.#parseOptions(optionsValue);
        const prompt =
            options.schema === undefined
                ? promptValue
                : [
                      promptValue,
                      "",
                      "Return only JSON matching this JSON Schema:",
                      JSON.stringify(options.schema),
                  ].join("\n");
        const signature = JSON.stringify({ options, prompt: promptValue });
        const callIndex = reservedCallIndex ?? this.#reserveAgentCallIndex();

        // An agent that was already asked exactly this, in a run this one continues, is not asked
        // again: the answer is the same and paying for it twice is the whole reason checkpoints
        // exist.
        const cached = this.#options.resumeAgentCalls[callIndex];
        if (cached?.signature === signature) {
            this.#agentCalls[callIndex] = cached;
            await this.#options.onAgentResult(callIndex, cached);
            this.#options.onLog(`Reused ${options.label ?? this.#phase} from the previous run.`);
            return cached.output;
        }

        const title = options.label ?? this.#phase;
        const answer = await this.#options.startAgent(
            {
                callIndex,
                signature,
                title,
                prompt,
                model: options.model,
                effort: options.effort,
                ...(options.provider === undefined ? {} : { provider: options.provider }),
                ...(options.service_tier === undefined
                    ? {}
                    : { serviceTier: options.service_tier }),
            },
            this.#options.signal,
        );
        const output =
            options.schema === undefined
                ? answer
                : parseStructuredWorkflowResult(answer, options.schema);
        const result = { output, signature };
        this.#agentCalls[callIndex] = result;
        await this.#options.onAgentResult(callIndex, result);
        return output;
    }

    /**
     * Every request at once, results in the order they were asked for. One agent failing is a
     * result of its own — `None` — rather than the end of the workflow, because a script that
     * fans out to twenty reviewers should still get the nineteen answers.
     */
    async #runParallel(requestsValue: unknown): Promise<unknown[]> {
        const requests = this.#parseRequests(requestsValue, "parallel");
        const callIndices = this.#reserveAgentCallIndices(requests.length);
        return await Promise.all(
            requests.map(async (request, index) => {
                try {
                    const { prompt, ...options } = request;
                    return await this.#runAgent(prompt, options, callIndices[index]);
                } catch (error: unknown) {
                    this.#options.onLog(
                        `${request.label ?? "Workflow agent"} failed: ${messageOf(error)}`,
                    );
                    return null;
                }
            }),
        );
    }

    /** Every item through every stage, items concurrently and stages in order within each item. */
    async #runPipeline(itemsValue: unknown, stagesValue: unknown): Promise<unknown[]> {
        if (!Array.isArray(itemsValue)) throw new Error("pipeline() requires a list of items.");
        const stages = this.#parseRequests(stagesValue, "pipeline");
        if (itemsValue.length > MAX_WORKFLOW_BATCH_ITEMS) {
            throw new Error(`pipeline() accepts at most ${MAX_WORKFLOW_BATCH_ITEMS} items.`);
        }
        const callIndices = this.#reserveAgentCallIndices(itemsValue.length * stages.length);
        return await Promise.all(
            itemsValue.map(async (item, index) => {
                let result: unknown = item;
                try {
                    for (const [stageIndex, stage] of stages.entries()) {
                        const { prompt: stagePrompt, ...options } = stage;
                        const prompt = [
                            stagePrompt,
                            "",
                            `Original item (${index + 1}/${itemsValue.length}):`,
                            serializeWorkflowValue(item),
                            "",
                            "Previous stage result:",
                            serializeWorkflowValue(result),
                        ].join("\n");
                        result = await this.#runAgent(
                            prompt,
                            options,
                            callIndices[index * stages.length + stageIndex],
                        );
                    }
                    return result;
                } catch (error: unknown) {
                    this.#options.onLog(`Pipeline item ${index + 1} failed: ${messageOf(error)}`);
                    return null;
                }
            }),
        );
    }

    #log(messageValue: unknown): null {
        if (typeof messageValue !== "string") throw new Error("log() requires a string.");
        this.#options.onLog(messageValue);
        return null;
    }

    #setPhase(titleValue: unknown): null {
        if (typeof titleValue !== "string" || titleValue.trim().length === 0) {
            throw new Error("phase() requires a non-empty title.");
        }
        this.#phase = titleValue.trim();
        this.#options.onPhase(this.#phase);
        this.#options.onLog(`Phase: ${this.#phase}`);
        return null;
    }

    #parseOptions(value: unknown): WorkflowAgentOptions {
        if (!Value.Check(workflowAgentOptionsSchema, value)) {
            throw new Error(
                "Agent options must be a dictionary with a model and a supported effort.",
            );
        }
        return normalizeOptions(value);
    }

    #parseRequests(value: unknown, functionName: string): WorkflowAgentRequest[] {
        if (!Array.isArray(value)) throw new Error(`${functionName}() requires a list.`);
        if (value.length > MAX_WORKFLOW_BATCH_ITEMS) {
            throw new Error(`${functionName}() accepts at most ${MAX_WORKFLOW_BATCH_ITEMS} items.`);
        }
        return value.map((item, index) => {
            if (!Value.Check(workflowAgentRequestSchema, item)) {
                throw new Error(
                    `${functionName}() item ${index + 1} must be a dictionary with prompt, model, and effort.`,
                );
            }
            return { ...normalizeOptions(item), prompt: item.prompt.trim() };
        });
    }

    #reserveAgentCallIndices(count: number): number[] {
        if (this.#nextAgentCallIndex + count > MAX_WORKFLOW_AGENT_COUNT) {
            throw new Error(`Workflows are limited to ${MAX_WORKFLOW_AGENT_COUNT} agent calls.`);
        }
        const first = this.#nextAgentCallIndex;
        this.#nextAgentCallIndex += count;
        return Array.from({ length: count }, (_unused, index) => first + index);
    }

    #reserveAgentCallIndex(): number {
        return this.#reserveAgentCallIndices(1)[0] ?? 0;
    }
}

function normalizeOptions<Options extends WorkflowAgentOptions>(options: Options): Options {
    return {
        ...options,
        model: options.model.trim(),
        ...(options.provider === undefined ? {} : { provider: options.provider.trim() }),
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error && error.message.length > 0
        ? error.message
        : "The agent did not finish.";
}
