import type { SessionOutputBlock, SessionToolLarkGrammar } from "@slopus/happy-providers";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import type { AgentKV } from "./AgentKV.js";

/** One durable invocation as handed directly to the tool that executes it. */
export interface AgentToolCall<Result extends TSchema = TSchema> {
    /** Stable Base-generated cuid2 identity, reused everywhere and across interrupted resumes. */
    readonly id: string;
    /** State owned by this invocation and erased atomically when its winning result commits. */
    readonly kv: AgentKV;
    /**
     * Atomically stage this structured result using the transaction carried by `ctx`. The first
     * successful commit wins; later commits and the eventual execute return value are ignored.
     */
    commit(ctx: Context, result: Static<Result>): Promise<Static<Result>>;
}

/** A tool-owned decision about one invocation while the agent is in Auto mode. */
export type AgentToolAutoPermissionPredicate<Args> = {
    bivarianceHack(args: Args, ctx: Context): boolean | Promise<boolean>;
}["bivarianceHack"];

/** Human-readable description of the exact action an Auto reviewer is deciding on. */
export type AgentToolAutoPermissionActionDescriber<Args> = {
    bivarianceHack(args: Args, ctx: Context): string;
}["bivarianceHack"];

/**
 * What a freeform tool is called with. A grammar constrains the model instead of a JSON schema, so
 * the call arrives as the text that grammar produced and is handed over under `input` exactly as
 * written. This is the one shape every grammar tool receives, which is why such a tool declares a
 * grammar rather than parameters of its own.
 */
export const agentGrammarToolParameters = Type.Object({ input: Type.String() });

/** The arguments of a freeform tool, as the agent hands them to `execute`. */
export type AgentGrammarToolArguments = Static<typeof agentGrammarToolParameters>;

/**
 * An executable tool with TypeBox-typed arguments and structured result. The descriptor fields
 * mirror the provider session tool. The agent validates arguments against `parameters` before
 * execute runs and the result against `returnType` after; `toLLM` renders the structured result
 * into model-facing content. A thrown execute, an invalid result, or `isError` returning true
 * becomes an error tool result for the model rather than failing the run.
 */
export interface AgentTool<Args extends TSchema = TSchema, Result extends TSchema = TSchema> {
    /** The tool name the model calls. */
    readonly name: string;
    /** Optional grouping the tool is exposed under, such as an MCP server name. */
    readonly namespace?: string;
    /** Description of the containing namespace, when this tool is namespaced. */
    readonly namespaceDescription?: string;
    /**
     * Exact native tool descriptor for a call the provider owns and settles inside its response.
     * Absence means the agent owns execution.
     */
    readonly server?: { readonly type: string; readonly [key: string]: unknown };
    /** Model-facing explanation of what the tool does and when to use it. */
    readonly description?: string;
    /** TypeBox schema the model's arguments are validated against before execute runs. */
    readonly parameters?: Args;
    /** TypeBox schema the structured result is validated against after execute runs. */
    readonly returnType: Result;
    /** Provider-neutral request to expose this tool through native tool discovery. */
    readonly defer?: boolean;
    /**
     * Human-readable capabilities this tool contributes to the model's instructions. Values are
     * trimmed and de-duplicated case-insensitively across the resolved tool set; first occurrence
     * order is preserved.
     */
    readonly capabilities?: readonly string[];
    /** Provider-facing terms used by native tool discovery to find this deferred tool. */
    readonly searchKeywords?: readonly string[];
    /**
     * Whether a provider-owned call is published to durable history observers. Defaults to true.
     * Base always retains its private model context. Setting this to false on an executable tool
     * is rejected so security and correctness hooks can never be hidden from client work.
     */
    readonly persistInHistory?: boolean;
    /**
     * Whether a provider-owned call's live events are published to ordinary observers. Defaults
     * to true and is independent of durable-history publication. Executable tools cannot hide.
     */
    readonly visibleToUser?: boolean;
    /**
     * Ignored by providers that do not support grammar-based tools. A tool that declares one is
     * freeform: it takes no parameters of its own, and its `execute` is handed the grammar's own
     * text under `input`. Use `defineAgentTool`, which types those arguments from this field.
     */
    readonly grammar?: SessionToolLarkGrammar;
    /**
     * Provider-shaped guidance shown only in Auto mode. Use this for fields the model must set
     * when it intentionally requests review or Full access.
     */
    readonly autoPermissionInstructions?: string;
    /**
     * Describes the exact action and boundary an Auto reviewer is deciding on. A tool whose
     * `shouldReviewInAutoMode` can return true must provide this description.
     */
    readonly describeAutoPermissionAction?: AgentToolAutoPermissionActionDescriber<Static<Args>>;
    /**
     * The tool cannot be contained by Rig's local restricted modes, so it is available only in
     * Auto or Full access. This does not itself approve an Auto invocation.
     */
    readonly requiresAutoOrFullAccess?: boolean;
    /**
     * Whether this exact invocation requires an Auto review. Every tool owns this decision;
     * routine tools state that explicitly with a predicate that returns false.
     */
    readonly shouldReviewInAutoMode: AgentToolAutoPermissionPredicate<Static<Args>>;
    /**
     * Whether an approved invocation must temporarily run in Full access. Review and elevation
     * are deliberately separate decisions; omission means the current sandbox remains active.
     */
    readonly shouldRunInFullAccessInAutoMode?: AgentToolAutoPermissionPredicate<Static<Args>>;
    /**
     * A durable tool is safe to execute again, so an interrupted call is retried when the agent
     * restarts. A non-durable call interrupted by a restart becomes an error tool result instead.
     */
    readonly durable?: boolean;
    /**
     * Whether drain and graceful shutdown may abandon this execution without recording a result,
     * leaving the same durable call to be re-executed by the next process. Reloadable tools are
     * intrinsically safe to retry after any restart, including when `durable` is omitted.
     */
    readonly reloadable?: boolean;
    /**
     * Whether steering or agent shutdown aborts this tool's execution context lifetime. Pending
     * steering aborts it immediately as execution begins; drain and shutdown also stop awaiting
     * it. Cancellation affects only this invocation, not the agent's turn or durable call state,
     * so a cooperative tool may return an ordinary interrupted result.
     */
    readonly steerable?: boolean;
    /**
     * Whether Agent Base wraps `execute` and its returned-result commit in one Agent Storage
     * transaction. A transactional tool commits only after `execute` returns successfully; a
     * throw, invalid result, or rendering failure rolls the transaction back.
     */
    readonly transactional?: boolean;
    /**
     * The context's lifetime aborts when the turn is aborted, so a long-running tool can
     * observe cancellation and stop its own work. For a transactional tool, `ctx.db` is the
     * active transaction facade.
     */
    execute(ctx: Context, args: Static<Args>, call: AgentToolCall<Result>): Promise<Static<Result>>;
    /** Renders a validated result into the content blocks the model actually sees. */
    toLLM(result: Static<Result>): readonly SessionOutputBlock[];
    /** Whether a structured result should be reported to the model as an error. */
    isError?(result: Static<Result>): boolean;
}

// Each tool keeps its concrete schemas; the agent needs one heterogeneous array, so this is the
// deliberate type-erased boundary. Arguments and results are validated against the concrete
// TypeBox schemas at runtime around every execution.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any, any>;

/**
 * A freeform tool as it is written: a grammar rather than parameters, and arguments it does not
 * get to choose. Declaring `parameters` here is rejected, because the grammar already decides what
 * the call looks like and the agent always hands that text over as `{ input }`.
 */
type AgentGrammarToolDefinition<Result extends TSchema> = Omit<
    AgentTool<typeof agentGrammarToolParameters, Result>,
    "grammar" | "parameters"
> & {
    readonly grammar: SessionToolLarkGrammar;
    readonly parameters?: never;
};

/**
 * Define a freeform tool. Its `execute` is typed from the grammar rather than from a schema the
 * tool wrote, so it receives the grammar's own text under `input` and cannot disagree with what
 * the agent actually passes.
 */
export function defineAgentTool<const Result extends TSchema>(
    tool: AgentGrammarToolDefinition<Result>,
): AgentTool<typeof agentGrammarToolParameters, Result>;
/** Define a tool with TypeBox-inferred argument and result types. */
export function defineAgentTool<const Args extends TSchema, const Result extends TSchema>(
    tool: AgentTool<Args, Result>,
): AgentTool<Args, Result>;
export function defineAgentTool<const Args extends TSchema, const Result extends TSchema>(
    tool: AgentTool<Args, Result> | AgentGrammarToolDefinition<Result>,
): AgentTool<Args, Result> {
    if (tool.grammar === undefined) return tool as AgentTool<Args, Result>;
    if (tool.parameters !== undefined) {
        throw new Error(
            `Tool "${tool.name}" declares both a grammar and parameters. A grammar tool is freeform: its grammar decides what a call looks like, and its arguments are always the text that grammar produced.`,
        );
    }
    // The grammar tool is given the parameters the agent will actually validate its calls against,
    // so the schema backing it is never one the tool could have written differently.
    return { ...tool, parameters: agentGrammarToolParameters } as unknown as AgentTool<
        Args,
        Result
    >;
}
