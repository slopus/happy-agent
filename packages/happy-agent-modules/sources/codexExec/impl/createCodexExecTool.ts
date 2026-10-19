import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    defineAgentTool,
    withAgentPermissionMode,
    type AgentBaseToolCall,
    type AgentBaseToolCallDecision,
    type AgentToolCall,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { SessionOutputBlock } from "@slopus/happy-providers";
import { withLifetime, type Context } from "@steve.kite/stdlib";

import { codexExecDeclaration, singleStringField } from "./codexExecDeclaration.js";
import { runCodexExecCell } from "./runCodexExecCell.js";

/** Codex's own grammar for `exec`: JavaScript source, optionally led by one pragma line. */
const CODEX_EXEC_GRAMMAR =
    "\nstart: pragma_source | plain_source\npragma_source: PRAGMA_LINE NEWLINE SOURCE\nplain_source: SOURCE\n\nPRAGMA_LINE: /[ \\t]*\\/\\/ @exec:[^\\r\\n]*/\nNEWLINE: /\\r?\\n/\nSOURCE: /[\\s\\S]+/\n";

/** The output budget Codex gives `exec` when the pragma names none. */
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

/** Codex states its budget in tokens; the isolate hands back characters. */
const CHARACTERS_PER_TOKEN = 4;

const outputBlockSchema = Type.Union([
    Type.Object(
        { type: Type.Literal("text"), text: Type.String() },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() },
        { additionalProperties: false },
    ),
]);

const codexExecResultSchema = Type.Object(
    {
        status: Type.Union([
            Type.Literal("completed"),
            Type.Literal("failed"),
            Type.Literal("terminated"),
        ]),
        wall_time_seconds: Type.Number(),
        items: Type.Array(outputBlockSchema),
    },
    { additionalProperties: false },
);

type CodexExecResult = Static<typeof codexExecResultSchema>;

/** Decides one nested call exactly as the same call made directly would be decided. */
export type CodexExecDecider = (
    ctx: Context,
    call: AgentBaseToolCall,
) => Promise<AgentBaseToolCallDecision | undefined>;

/**
 * Codex's `exec`: one JavaScript cell that reaches every other tool as `tools.<name>`.
 *
 * Each nested call is validated against its tool's own schema, decided by the same permission
 * decision a direct call gets, run under that decision, and validated against its own result
 * schema. Its structured result is what the script receives. A refusal becomes an exception the
 * script can catch, so one refused call never runs and never silently turns into success.
 */
export function createCodexExecTool(nested: readonly AnyAgentTool[], decide: CodexExecDecider) {
    const entries = nestedEntries(nested);
    const byName = new Map(entries.map((entry) => [entry.name, entry.tool]));
    return defineAgentTool({
        name: "exec",
        defer: false,
        capabilities: [...new Set(nested.flatMap((tool) => tool.capabilities ?? []))],
        description: codexExecDescription(entries),
        grammar: { type: "lark", grammar: CODEX_EXEC_GRAMMAR },
        returnType: codexExecResultSchema,
        // A script's nested calls change the machine, so running it again after a restart would
        // repeat them.
        durable: false,
        // The cell itself does nothing but run JavaScript. Every nested call is decided on its own.
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }, call) => {
            const started = performance.now();
            let index = 0;
            const cell = await runCodexExecCell({
                source: input,
                catalog: entries.map(({ name, description }) => ({ name, description })),
                signal: ctx.lifetime ?? new AbortController().signal,
                call: async (name, raw, signal) => {
                    const tool = byName.get(name);
                    if (tool === undefined) throw new Error(`There is no nested tool ${name}.`);
                    index += 1;
                    return await runNestedTool(ctx, call, index, tool, raw, signal, decide);
                },
            });
            const items = [
                ...cell.items,
                ...(cell.error === undefined
                    ? []
                    : [{ type: "text" as const, text: `Script error:\n${cell.error}` }]),
            ];
            return {
                status: cell.status,
                wall_time_seconds: Math.round((performance.now() - started) / 100) / 10,
                items: truncateItems(items, maxOutputTokens(input)),
            };
        },
        isError: (result) => result.status !== "completed",
        toLLM: (result) => [
            {
                type: "text",
                text: `${statusLine(result)}\nWall time ${result.wall_time_seconds.toFixed(1)} seconds\nOutput:\n`,
            },
            ...result.items,
        ],
    });
}

async function runNestedTool(
    ctx: Context,
    call: AgentToolCall,
    index: number,
    tool: AnyAgentTool,
    raw: unknown,
    signal: AbortSignal,
    decide: CodexExecDecider,
): Promise<unknown> {
    const args = nestedArguments(tool, raw);
    assertArguments(tool, args);
    // Permission events name the exec call, which is the call the conversation actually holds.
    const decision = await decide(ctx, { callId: call.id, tool, arguments: args });
    if (decision?.type === "answer") {
        throw new Error(
            decision.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n") || `${tool.name} was refused.`,
        );
    }
    const ran = decision?.tool ?? tool;
    const ranArguments = decision?.arguments ?? args;
    if (ran !== tool || ranArguments !== args) assertArguments(ran, ranArguments);
    const decided =
        decision?.permissionMode === undefined
            ? ctx
            : withAgentPermissionMode(ctx, decision.permissionMode);
    const nestedCall: AgentToolCall = {
        id: `${call.id}_${String(index)}`,
        kv: call.kv.scoped("nested", String(index)),
        // The cell is not durable, so a nested result has nothing of its own to stage.
        commit: async (_ctx, result) => result,
    };
    const result: unknown = await ran.execute(
        withLifetime(decided, AbortSignal.any([...(ctx.lifetime ? [ctx.lifetime] : []), signal])),
        ranArguments,
        nestedCall,
    );
    if (!Value.Check(ran.returnType, result)) {
        throw new Error(`${ran.name} returned a result outside its own schema.`);
    }
    return result;
}

/** A string stands for a freeform tool's text, or for a tool's one required string argument. */
function nestedArguments(tool: AnyAgentTool, raw: unknown): unknown {
    if (raw === null || raw === undefined) return {};
    if (typeof raw !== "string") return raw;
    if (tool.grammar !== undefined) return { input: raw };
    const field = singleStringField(tool);
    if (field === undefined) throw new Error(`${tool.name} takes an object, not a string.`);
    return { [field]: raw };
}

function assertArguments(tool: AnyAgentTool, args: unknown): void {
    if (tool.parameters === undefined) return;
    const error = Value.Errors(tool.parameters, args).First();
    if (error === undefined) return;
    throw new Error(
        `Invalid arguments for ${tool.name}: ${error.path === "" ? "the input" : error.path} ${error.message}.`,
    );
}

interface NestedEntry {
    readonly name: string;
    readonly description: string;
    readonly tool: AnyAgentTool;
}

/** Each tool under a JavaScript identifier, as Codex names them: `namespace__name`. */
function nestedEntries(tools: readonly AnyAgentTool[]): readonly NestedEntry[] {
    const entries: NestedEntry[] = [];
    const taken = new Set<string>();
    for (const tool of tools) {
        const qualified =
            tool.namespace === undefined ? tool.name : `${tool.namespace}__${tool.name}`;
        const name = qualified.replaceAll(/[^A-Za-z0-9_$]/g, "_").replace(/^(?=\d)/, "_");
        if (taken.has(name)) continue;
        taken.add(name);
        const description = [
            tool.description ?? "",
            `exec tool declaration:\n\`\`\`ts\n${codexExecDeclaration(name, tool)}\n\`\`\``,
        ]
            .filter((part) => part.length > 0)
            .join("\n\n");
        entries.push({ name, description, tool });
    }
    return entries;
}

/**
 * Codex's own `exec` description, adapted to what this cell really offers, followed by the
 * declarations of the tools offered eagerly. Deferred tools are listed only in `ALL_TOOLS`, which
 * carries their declarations too.
 */
function codexExecDescription(entries: readonly NestedEntry[]): string {
    const sections: string[] = [CODEX_EXEC_HEADER];
    let namespace: string | undefined;
    for (const entry of entries) {
        if (entry.tool.defer === true) continue;
        if (entry.tool.namespace !== namespace) {
            namespace = entry.tool.namespace;
            if (namespace !== undefined) {
                sections.push(
                    `## ${namespace}\n${entry.tool.namespaceDescription ?? `Tools in the ${namespace} namespace.`}`,
                );
            }
        }
        sections.push(`### \`${entry.name}\`\n${entry.description}`);
    }
    return sections.join("\n\n");
}

const CODEX_EXEC_HEADER = `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh QuickJS isolate as an async module.
- All nested tools are available on the global \`tools\` object, for example \`await tools.exec_command(...)\`. Tool names are exposed as normalized JavaScript identifiers, for example \`await tools.mcp__ologs__get_profile(...)\`.
- Nested tool methods take either a string or an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- Runs raw JavaScript -- no Node, no file system, no network access, no console.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"max_output_tokens": 1000}\`.
- \`max_output_tokens\` sets the token budget for direct \`exec\` results. Defaults to ${String(DEFAULT_MAX_OUTPUT_TOKENS)} tokens.
- A script runs until it finishes. A command that outlives its own \`yield_time_ms\` keeps running and returns a \`session_id\`; poll it with \`tools.write_stdin\` in this or a later \`exec\`.
- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(imageUrlOrItem: string | { image_url: string } | { data: string; mimeType: string })\`: Appends an image item. \`image_url\` should be a base64-encoded \`data:\` URL. An image block with \`data\` and \`mimeType\` (or \`mime_type\`) is accepted as well, for example \`image((await tools.view_image({ path })).image)\`.
- \`setTimeout(callback: () => void, delayMs?: number)\`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep \`exec\` alive by themselves; await an explicit promise if you need to wait for one.
- \`clearTimeout(timeoutId?: number)\`: cancels a timeout created by \`setTimeout\`.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.

Some deferred nested tools may be omitted from this description. They are still available on the global \`tools\` object and listed in \`ALL_TOOLS\`.
To find one, filter \`ALL_TOOLS\` by \`name\` and \`description\`.`;

function statusLine(result: CodexExecResult): string {
    switch (result.status) {
        case "completed":
            return "Script completed";
        case "failed":
            return "Script failed";
        case "terminated":
            return "Script terminated";
    }
}

/** The output budget from the optional `// @exec: {...}` first line. */
function maxOutputTokens(source: string): number {
    const pragma = /^[ \t]*\/\/ @exec:([^\r\n]*)/u.exec(source)?.[1];
    if (pragma === undefined) return DEFAULT_MAX_OUTPUT_TOKENS;
    try {
        const parsed = JSON.parse(pragma) as { max_output_tokens?: unknown };
        const tokens = parsed.max_output_tokens;
        return typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0
            ? Math.floor(tokens)
            : DEFAULT_MAX_OUTPUT_TOKENS;
    } catch {
        return DEFAULT_MAX_OUTPUT_TOKENS;
    }
}

/**
 * Fit the text within the token budget the way Codex does: the text items become one, cut in the
 * middle with a count of what was removed, and images are kept.
 */
function truncateItems(
    items: readonly SessionOutputBlock[],
    maxTokens: number,
): SessionOutputBlock[] {
    const text = items
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    const budget = maxTokens * CHARACTERS_PER_TOKEN;
    if (text.length <= budget) return [...items];
    const removedTokens = Math.ceil((text.length - budget) / CHARACTERS_PER_TOKEN);
    const half = Math.floor(budget / 2);
    const shortened = `Total output lines: ${String(text.split("\n").length)}\n\n${text.slice(0, half)}…${String(removedTokens)} tokens truncated…${text.slice(text.length - half)}`;
    return [{ type: "text", text: shortened }, ...items.filter((item) => item.type === "image")];
}
