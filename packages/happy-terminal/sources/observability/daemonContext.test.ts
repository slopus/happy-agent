import type { Logger } from "@steve.kite/stdlib";
import { SpanStatusCode, type Attributes, type Span, type Tracer } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

import {
    initializeDaemonContext,
    setSpanAttributes,
    withProcessContext,
    withRequestContext,
} from "./daemonContext.js";

describe("daemon context", () => {
    it("creates a semantic context only while its operation is running", async () => {
        const records: { context: Readonly<Record<string, unknown>>; message: unknown }[] = [];
        const logger: Logger = {
            trace: (context, message) => records.push({ context, message }),
            debug: (context, message) => records.push({ context, message }),
            info: (context, message) => records.push({ context, message }),
            warn: (context, message) => records.push({ context, message }),
            error: (context, message) => records.push({ context, message }),
            fatal: (context, message) => records.push({ context, message }),
        };

        initializeDaemonContext(logger);
        let contextName: string | undefined;
        await withProcessContext("git", async (ctx) => {
            contextName = ctx.name;
            ctx.log.info("started");
        });
        expect(contextName).toBe("happy.terminal.process.git");
        expect(records).toEqual([
            { context: { context: "happy.terminal.process.git" }, message: "started" },
        ]);
    });

    it("records successful work and closes the span without exposing it", async () => {
        const logger = silentLogger();
        const telemetry = fakeTracer();
        initializeDaemonContext(logger, telemetry.tracer);
        expect(telemetry.startSpan).not.toHaveBeenCalled();

        const result = await withRequestContext("test", {}, async (ctx) => {
            setSpanAttributes(ctx, { "happy-terminal.test.attribute": "value" });
            return 42;
        });

        expect(result).toBe(42);
        expect(telemetry.startSpan).toHaveBeenCalledWith(
            "happy.terminal.api.test",
            undefined,
            expect.anything(),
        );
        expect(telemetry.setAttributes).toHaveBeenCalledWith({
            "happy-terminal.test.attribute": "value",
        });
        expect(telemetry.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
        expect(telemetry.recordException).not.toHaveBeenCalled();
        expect(telemetry.end).toHaveBeenCalledOnce();
    });

    it("records a failed operation, closes its span, and preserves the thrown value", async () => {
        const failure = new Error("database unavailable");
        const telemetry = fakeTracer();
        initializeDaemonContext(silentLogger(), telemetry.tracer);
        expect(telemetry.startSpan).not.toHaveBeenCalled();

        await expect(
            withRequestContext("failure", {}, async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);

        expect(telemetry.recordException).toHaveBeenCalledWith(failure);
        expect(telemetry.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
        expect(telemetry.end).toHaveBeenCalledOnce();
    });
});

function silentLogger(): Logger {
    const write = () => undefined;
    return { debug: write, error: write, fatal: write, info: write, trace: write, warn: write };
}

function fakeTracer(): {
    end: ReturnType<typeof vi.fn>;
    recordException: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    startSpan: ReturnType<typeof vi.fn>;
    tracer: Tracer;
} {
    const setAttributes = vi.fn<(attributes: Attributes) => Span>();
    const setStatus = vi.fn();
    const recordException = vi.fn();
    const end = vi.fn();
    const span = {
        end,
        recordException,
        setAttributes,
        setStatus,
    } as unknown as Span;
    setAttributes.mockReturnValue(span);
    const startSpan = vi.fn(() => span);
    return {
        end,
        recordException,
        setAttributes,
        setStatus,
        startSpan,
        tracer: { startSpan } as unknown as Tracer,
    };
}
