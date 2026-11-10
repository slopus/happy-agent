import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";

import {
    agentDatabaseRows,
    ensureAgentDatabaseConnection,
    type AgentMetadata,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@slopus/happy-agent-base";
import type { UiActionRequest, UiPermissionId } from "@slopus/happy-agent-client";
import { UI_PERMISSION_IDS } from "@slopus/happy-agent-client";
import { withLogger, type Context, type Logger } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";

import { ChatUiModule, type ChatUiActionResult } from "../../../sources/chatUi/index.js";
import { ConfigModule } from "../../../sources/config/index.js";
import { DurableFunctionsModule } from "../../../sources/durableFunctions/index.js";
import { HistoryModule, type HistoryMessage } from "../../../sources/history/index.js";
import { moduleDatabase } from "../../support/moduleDatabase.js";
import { resolveModuleHooks } from "../../support/moduleHooks.js";

/** The conversation every example happens in. */
export const AGENT_ID = "agentone";

/** One hidden message chat UI sent to start a turn. */
export interface WakeMessage {
    readonly agentId: string;
    readonly text: string;
    readonly hideFromUser: boolean;
}

/**
 * The real chat UI module on a real database, with real Config, History, and Durable Functions
 * beside it, in a throwaway installation. Only the agent collection stands in: it records the
 * turns chat UI starts instead of running a model.
 */
export async function chatUiWorld(
    options: {
        /** The parent of the conversation's agent, for one another agent manages. */
        readonly parent?: string;
        readonly metadata?: AgentMetadata;
        /** Fail the turn chat UI starts for a waking note. */
        readonly failWake?: boolean;
        /** Components of the test's own, contributed before the modules start. */
        readonly contribute?: (chatUi: ChatUiModule) => void;
        /** The installation to start again on, as after the daemon restarted. */
        readonly installation?: {
            readonly root: string;
            readonly database: ReturnType<typeof moduleDatabase>;
        };
    } = {},
) {
    const root = options.installation?.root ?? (await mkdtemp(join(tmpdir(), "chat-ui-world-")));
    const home = join(root, "home");
    const config = await ConfigModule.load(join(root, "happy"), {
        environment: {
            CODEX_HOME: join(home, ".codex"),
            GROK_HOME: join(home, ".grok"),
            HOME: home,
            PATH: "/usr/bin:/bin",
        },
    });
    const durable = new DurableFunctionsModule();
    const history = new HistoryModule();
    const chatUi = new ChatUiModule(config, history, durable);
    options.contribute?.(chatUi);
    const database =
        options.installation?.database ??
        moduleDatabase(
            [...history.migrations, ...durable.migrations, ...chatUi.migrations],
            "chat-ui-world",
        );
    ensureAgentDatabaseConnection(database.database);
    await database.ready;

    const logs: string[] = [];
    const ctx = withLogger(database.context, recordingLogger(logs));
    const wakes: WakeMessage[] = [];
    const agents = {
        parentOf: () => Promise.resolve(options.parent ?? null),
        config: () => Promise.resolve({ metadata: options.metadata }),
        send: (
            _ctx: Context,
            agentId: string,
            message: { readonly content: readonly { readonly text?: string }[] },
            sendOptions: { readonly id: string; readonly metadata?: Record<string, unknown> },
        ) => {
            if (options.failWake === true) return Promise.reject(new Error("No model is here."));
            wakes.push({
                agentId,
                text: message.content.map((block) => block.text ?? "").join(""),
                hideFromUser: sendOptions.metadata?.["hideFromUser"] === true,
            });
            return Promise.resolve({ id: sendOptions.id });
        },
        updateMetadata: () => Promise.resolve(),
    } as unknown as AgentSystemRef;
    const hooks = {
        history: await resolveModuleHooks(ctx, history, agents),
        chatUi: await resolveModuleHooks(ctx, chatUi, agents),
        durable: await resolveModuleHooks(ctx, durable, agents),
    };
    await hooks.durable.afterStart?.(ctx, agents);

    /** Every message History announced, and every attempt record whose outcome changed. */
    const appended: HistoryMessage[] = [];
    const updated: HistoryMessage[] = [];
    history.onAppend((_ctx, _agentId, messages) => {
        appended.push(...messages);
    });
    chatUi.onRecordUpdated((_agentId, record) => {
        updated.push(record);
    });

    const kv = new Map<string, unknown>();
    const store = {
        delete: (_ctx: unknown, key: string) => {
            kv.delete(key);
            return Promise.resolve();
        },
        read: (_ctx: unknown, key: string) => Promise.resolve(kv.get(key)),
        write: (_ctx: unknown, key: string, value: unknown) => {
            kv.set(key, structuredClone(value));
            return Promise.resolve();
        },
    };
    const scope = {
        agent: { id: AGENT_ID, metadata: options.metadata, provider: "codex" },
        historyKV: store,
        kv: store,
        runKV: store,
        sharedKV: store,
    } as unknown as AgentModuleScope;
    let calls = 0;

    /** The tools chat UI gives this conversation's model. */
    const tools = async (): Promise<readonly AnyAgentTool[]> =>
        (await hooks.chatUi.tools?.(ctx, scope)) ?? [];

    /**
     * A model's tool call from start to finish: the real tool runs, and History records the call
     * and its result the way it does for an agent's turn. Answers the message holding the call.
     */
    const call = async (
        name: string,
        args: Record<string, unknown>,
    ): Promise<{
        readonly messageId: string;
        readonly callId: string;
        readonly output: string;
    }> => {
        const tool = (await tools()).find((candidate) => candidate.name === name);
        if (tool === undefined) throw new Error(`The model has no ${name} tool here.`);
        calls += 1;
        const callId = `call${String(calls)}`;
        const messageId = `inference${String(calls)}`;
        await history.record(ctx, AGENT_ID, {
            recordId: messageId,
            role: "assistant",
            blocks: [
                { type: "text", text: "Here you go." },
                { type: "tool_call", callId, name, arguments: args },
            ],
        });
        await hooks.history.beforeToolCallTransact!(ctx, scope, {
            type: "tool_call",
            callId,
            name,
            arguments: JSON.stringify(args),
        });
        let result: unknown;
        let failure: string | undefined;
        try {
            result = await tool.execute(ctx, args, { id: callId } as never);
        } catch (error: unknown) {
            failure = error instanceof Error ? error.message : String(error);
        }
        const content =
            failure === undefined
                ? tool.toLLM(result)
                : ([{ type: "text", text: failure }] as const);
        if (failure === undefined) {
            await hooks.history.afterToolCall!(ctx, scope, {
                arguments: args,
                callId,
                content,
                isError: false,
                result,
                tool: tool as never,
            });
        }
        await hooks.history.afterToolCallTransact!(ctx, scope, {
            role: "tool",
            callId,
            content,
            ...(failure === undefined ? {} : { isError: true }),
        } as never);
        return {
            messageId,
            callId,
            output: content.map((block) => ("text" in block ? block.text : "")).join(""),
        };
    };

    /** One click, as the `/actions` route hands it to chat UI after its own checks. */
    const click = async (
        request: UiActionRequest,
        person: {
            readonly userId?: string;
            readonly granted?: readonly UiPermissionId[];
        } = {},
    ): Promise<ChatUiActionResult> =>
        await chatUi.act(ctx, {
            agentId: AGENT_ID,
            request,
            person: {
                userId: person.userId,
                granted: new Set(person.granted ?? UI_PERMISSION_IDS),
            },
        });

    /** Everything this world stored, announced, sent, or logged, as one searchable text. */
    const everything = async (): Promise<string> => {
        const tables: unknown[] = [];
        const names = await agentDatabaseRows<{ name: string }>(
            ctx.db,
            sql`SELECT name FROM sqlite_master WHERE type = 'table'`,
        );
        for (const { name } of names) {
            tables.push(await agentDatabaseRows(ctx.db, sql.raw(`SELECT * FROM "${name}"`)));
        }
        return JSON.stringify({ tables, appended, updated, wakes, logs, kv: [...kv.entries()] });
    };

    const attempts = async () =>
        await agentDatabaseRows<{ id: string; status: string }>(
            ctx.db,
            sql`SELECT id, status FROM happy_agent_chat_ui_attempts ORDER BY created_at, id`,
        );

    return {
        ctx,
        config,
        history,
        durable,
        chatUi,
        hooks: hooks as { readonly [name: string]: AgentModuleHooks },
        scope,
        tools,
        call,
        click,
        everything,
        attempts,
        wakes,
        appended,
        updated,
        logs,
        /** The model's next turn: the notes waiting for it, as the hidden message it reads. */
        nextTurnNotes: async (): Promise<string[]> =>
            ((await hooks.chatUi.beforeTurn?.(ctx, scope, {} as never)) ?? []).flatMap((action) =>
                action.type === "inject"
                    ? action.message.content.flatMap((block) =>
                          block.type === "text" ? [block.text] : [],
                      )
                    : [],
            ),
        /** The same installation started again: new modules over what the old ones stored. */
        restart: async (contribute?: (chatUi: ChatUiModule) => void) => {
            durable.stop();
            return await chatUiWorld({
                ...options,
                ...(contribute === undefined ? {} : { contribute }),
                installation: { root, database },
            });
        },
        close: async (): Promise<void> => {
            durable.stop();
            if (options.installation !== undefined) return;
            database.close();
            await rm(root, { force: true, recursive: true });
        },
    };
}

export type ChatUiWorld = Awaited<ReturnType<typeof chatUiWorld>>;

/** A logger that keeps every line, whatever its level. */
function recordingLogger(lines: string[]): Logger {
    const write = (_context: unknown, ...args: unknown[]) => {
        lines.push(
            args.map((value) => (typeof value === "string" ? value : inspect(value))).join(" "),
        );
    };
    return { trace: write, debug: write, info: write, warn: write, error: write, fatal: write };
}
