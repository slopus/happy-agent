import type {
    AgentModule,
    AgentModuleScope,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import {
    createRootContext,
    withLogger,
    withTracer,
    type LogContext,
    type Logger,
} from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { afterEach, describe, expect, it, vi } from "vitest";

import { instrumentModuleLogging } from "../../sources/runtime/instrumentModuleLogging.js";
import { recordingTracer } from "../support/recordingTracer.js";

interface LogRecord {
    readonly context: LogContext;
    readonly level: keyof Logger;
    readonly message: string;
}

afterEach(() => {
    vi.useRealTimers();
});

describe("instrumentModuleLogging", () => {
    it("traces startup and restoration with correctly nested child work", async () => {
        const { tracer, spans } = recordingTracer();
        const ctx = withTracer(createRootContext(), tracer);
        let finishStartup = () => {};
        const gate = new Promise<void>((resolve) => {
            finishStartup = resolve;
        });
        const module: AgentModule<AnyAgentTool, LibSQLDatabase> = {
            name: "example",
            async beforeStart(ctx) {
                await ctx.span("startup.work", () => gate);
                return {
                    afterStart: (ctx) => ctx.span("after-start.work", () => undefined),
                    agentRestored: (ctx) => ctx.span("restore.work", () => undefined),
                    instructions: () => "synchronous result",
                };
            },
        };
        const wrapped = instrumentModuleLogging(module);
        expect(instrumentModuleLogging(wrapped)).toBe(wrapped);
        const starting = wrapped.beforeStart!(ctx, {} as AgentSystemRef<LibSQLDatabase>);
        expect(spans.map((span) => span.ends)).toEqual([0, 0]);
        finishStartup();
        const hooks = await starting;
        await hooks?.afterStart?.(ctx, {} as never);
        await hooks?.agentRestored?.(ctx, {} as never, {} as never);
        expect(hooks?.instructions?.(ctx, {} as never)).toBe("synchronous result");
        expect(spans.map((span) => span.name)).toEqual([
            "module.example.beforeStart",
            "startup.work",
            "module.example.afterStart",
            "after-start.work",
            "module.example.agentRestored",
            "restore.work",
            "module.example.instructions",
        ]);
        expect(spans[1]?.parent).toBe(spans[0]);
        expect(spans[3]?.parent).toBe(spans[2]);
        expect(spans[5]?.parent).toBe(spans[4]);
        expect(spans.every((span) => span.ends === 1 && span.errors.length === 0)).toBe(true);
    });

    it("ends failed startup and sync/async hook spans without changing their errors", async () => {
        const { tracer, spans } = recordingTracer();
        const ctx = withTracer(createRootContext(), tracer);
        const failure = new Error("loading failed");
        const broken = instrumentModuleLogging({
            name: "broken",
            beforeStart: async () => {
                throw failure;
            },
        });
        await expect(broken.beforeStart!(ctx, {} as never)).rejects.toBe(failure);
        const hooks = await instrumentModuleLogging({
            name: "hooks",
            beforeStart: () => ({
                instructions: () => {
                    throw failure;
                },
                agentRestored: async () => {
                    throw failure;
                },
            }),
        }).beforeStart!(ctx, {} as never);
        expect(() => hooks?.instructions?.(ctx, {} as never)).toThrow(failure);
        await expect(hooks?.agentRestored?.(ctx, {} as never, {} as never)).rejects.toBe(failure);
        expect(spans.map((span) => span.errors)).toEqual([[failure], [], [failure], [failure]]);
        expect(spans.every((span) => span.ends === 1)).toBe(true);
    });

    it("labels module startup and every hook context while preserving results", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const records: LogRecord[] = [];
        const ctx = withLogger(createRootContext(), recordingLogger(records));
        const module: AgentModule<AnyAgentTool, LibSQLDatabase> = {
            name: "example",
            beforeStart(startCtx) {
                startCtx.log.info("module-owned startup message");
                return {
                    instructions(hookCtx) {
                        hookCtx.log.info("module-owned hook message");
                        return "instructions";
                    },
                };
            },
        };

        const instrumented = instrumentModuleLogging(module);
        const hooks = await instrumented.beforeStart?.(ctx, {} as AgentSystemRef<LibSQLDatabase>);
        const instructions = await hooks?.instructions?.(
            ctx,
            {} as AgentModuleScope<LibSQLDatabase>,
        );

        expect(instructions).toBe("instructions");
        expect(records.map((record) => record.message)).toEqual([
            'module:start module="example"',
            "module-owned startup message",
            'module:ready module="example" durationMs=0',
            'module:hook:start module="example" hook="instructions"',
            "module-owned hook message",
            'module:hook:finish module="example" hook="instructions" durationMs=0',
        ]);
        expect(records.every((record) => record.context.module === "example")).toBe(true);
    });

    it("logs and preserves a hook failure", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const records: LogRecord[] = [];
        const ctx = withLogger(createRootContext(), recordingLogger(records));
        const failure = new Error("broken hook");
        const module: AgentModule<AnyAgentTool, LibSQLDatabase> = {
            name: "failure",
            beforeStart: () => ({
                beforeInference: () => {
                    throw failure;
                },
            }),
        };
        const hooks = await instrumentModuleLogging(module).beforeStart?.(
            ctx,
            {} as AgentSystemRef<LibSQLDatabase>,
        );

        expect(() =>
            hooks?.beforeInference?.(ctx, {} as AgentModuleScope<LibSQLDatabase>, {} as never),
        ).toThrow(failure);
        expect(records.at(-1)).toMatchObject({
            context: { module: "failure" },
            level: "error",
            message:
                'module:hook:error module="failure" hook="beforeInference" durationMs=0 error="broken hook"',
        });
    });

    it("does not emit per-delta trace records for provider event hooks", async () => {
        const records: LogRecord[] = [];
        const { tracer, spans } = recordingTracer();
        const ctx = withTracer(withLogger(createRootContext(), recordingLogger(records)), tracer);
        const onEvent = vi.fn();
        const module: AgentModule<AnyAgentTool, LibSQLDatabase> = {
            name: "events",
            beforeStart: () => ({ onEvent }),
        };
        const hooks = await instrumentModuleLogging(module).beforeStart?.(
            ctx,
            {} as AgentSystemRef<LibSQLDatabase>,
        );
        records.length = 0;
        spans.length = 0;

        await hooks?.onEvent?.(ctx, {} as AgentModuleScope<LibSQLDatabase>, {
            type: "text_delta",
            delta: "hello",
        });

        expect(onEvent).toHaveBeenCalledOnce();
        expect(records).toEqual([]);
        expect(spans).toEqual([]);
    });
});

function recordingLogger(records: LogRecord[]): Logger {
    const write =
        (level: keyof Logger) =>
        (context: LogContext, ...args: readonly unknown[]) => {
            records.push({ context, level, message: args.map(String).join(" ") });
        };
    return {
        debug: write("debug"),
        error: write("error"),
        fatal: write("fatal"),
        info: write("info"),
        trace: write("trace"),
        warn: write("warn"),
    };
}
