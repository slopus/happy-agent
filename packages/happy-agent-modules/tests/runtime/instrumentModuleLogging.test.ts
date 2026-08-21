import type {
    AgentModule,
    AgentModuleScope,
    AgentSystemRef,
    AnyAgentTool,
} from "@slopus/happy-agent-base";
import { createRootContext, withLogger, type LogContext, type Logger } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { afterEach, describe, expect, it, vi } from "vitest";

import { instrumentModuleLogging } from "../../sources/runtime/instrumentModuleLogging.js";

interface LogRecord {
    readonly context: LogContext;
    readonly level: keyof Logger;
    readonly message: string;
}

afterEach(() => {
    vi.useRealTimers();
});

describe("instrumentModuleLogging", () => {
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
        const ctx = withLogger(createRootContext(), recordingLogger(records));
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

        await hooks?.onEvent?.(ctx, {} as AgentModuleScope<LibSQLDatabase>, {
            type: "text_delta",
            delta: "hello",
        });

        expect(onEvent).toHaveBeenCalledOnce();
        expect(records).toEqual([]);
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
