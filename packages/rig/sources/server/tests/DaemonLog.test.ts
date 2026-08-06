import { describe, expect, it, vi } from "vitest";

import { DaemonLog } from "../DaemonLog.js";
import { installDaemonProcessFailureLogging } from "../installDaemonProcessFailureLogging.js";
import { recordProviderFailure } from "../recordProviderFailure.js";

describe("DaemonLog", () => {
    it("writes timestamped JSON lines with daemon identity and event details", () => {
        const lines: string[] = [];
        const log = new DaemonLog({
            now: () => Date.parse("2026-07-24T07:30:00.000Z"),
            path: "/state/server.log",
            pid: 4321,
            version: "0.0.46",
            write: (_path, line) => lines.push(line),
        });

        log.record("info", "daemon_starting", "Rig daemon is starting.", {
            databasePath: "/home/tester/.happy/rig/sessions.sqlite",
            socketPath: "/tmp/rig-501/server.sock",
        });

        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toEqual({
            databasePath: "/home/tester/.happy/rig/sessions.sqlite",
            event: "daemon_starting",
            level: "info",
            message: "Rig daemon is starting.",
            pid: 4321,
            socketPath: "/tmp/rig-501/server.sock",
            timestamp: "2026-07-24T07:30:00.000Z",
            version: "0.0.46",
        });
        expect(lines[0]).toMatch(/\n$/u);
    });

    it("records fatal process failures without taking ownership of process termination", () => {
        const lines: string[] = [];
        const log = new DaemonLog({
            now: () => Date.parse("2026-07-24T07:31:00.000Z"),
            path: "/state/server.log",
            pid: 4321,
            version: "0.0.46",
            write: (_path, line) => lines.push(line),
        });
        const processEvents = {
            listener: undefined as
                | ((error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void)
                | undefined,
            off: vi.fn(),
            on: vi.fn(
                (
                    _event: "uncaughtExceptionMonitor",
                    listener: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void,
                ) => {
                    processEvents.listener = listener;
                },
            ),
        };
        const writeCrashReport = vi.fn();

        const uninstall = installDaemonProcessFailureLogging(log, processEvents, writeCrashReport);
        const failure = new Error("cannot send on a closed WebSocket");
        processEvents.listener?.(failure, "unhandledRejection");
        uninstall();

        const record = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(record).toMatchObject({
            errorMessage: "cannot send on a closed WebSocket",
            errorName: "Error",
            event: "daemon_fatal_error",
            level: "error",
            message: "Rig daemon is terminating after an unhandled rejection.",
            origin: "unhandledRejection",
        });
        expect(record.errorStack).toContain("cannot send on a closed WebSocket");
        expect(writeCrashReport).toHaveBeenCalledWith(failure);
        expect(processEvents.on).toHaveBeenCalledOnce();
        expect(processEvents.off).toHaveBeenCalledWith(
            "uncaughtExceptionMonitor",
            processEvents.listener,
        );
    });

    it("records a diagnostic failure without hiding the original daemon stack", () => {
        const lines: string[] = [];
        const log = new DaemonLog({
            path: "/state/server.log",
            write: (_path, line) => lines.push(line),
        });
        const processEvents = {
            listener: undefined as
                | ((error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void)
                | undefined,
            off: vi.fn(),
            on: vi.fn(
                (
                    _event: "uncaughtExceptionMonitor",
                    listener: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void,
                ) => {
                    processEvents.listener = listener;
                },
            ),
        };

        installDaemonProcessFailureLogging(log, processEvents, () => {
            throw new Error("diagnostics disk is full");
        });
        processEvents.listener?.(new Error("daemon crash"), "uncaughtException");

        expect(lines.map((line) => JSON.parse(line))).toEqual([
            expect.objectContaining({
                errorMessage: "daemon crash",
                event: "daemon_fatal_error",
            }),
            expect.objectContaining({
                errorMessage: "diagnostics disk is full",
                event: "daemon_crash_report_failed",
            }),
        ]);
    });

    it("does not turn a logging failure into a daemon failure", () => {
        const log = new DaemonLog({
            path: "/unwritable/server.log",
            write: () => {
                throw new Error("disk unavailable");
            },
        });

        expect(() =>
            log.record("error", "daemon_startup_failed", "Rig daemon could not start."),
        ).not.toThrow();
    });

    it("records bounded provider diagnostics from a durable terminal event", () => {
        const lines: string[] = [];
        const log = new DaemonLog({
            path: "/state/server.log",
            write: (_path, line) => lines.push(line),
        });

        recordProviderFailure(log, {
            createdAt: 1,
            data: {
                errorMessage: "Internal server error",
                modelLocked: false,
                providerError: {
                    type: "internal_server_error",
                    diagnostics: {
                        attempts: 3,
                        code: "model_backend_failure",
                        requestId: "request-123",
                        status: 502,
                        upstreamMessage: "Internal server error",
                    },
                },
                providerId: "bedrock",
                requestedModelId: "openai.gpt-5.6-sol",
                runId: "run-1",
                stopReason: "error",
            },
            id: "event-1",
            sessionId: "session-1",
            type: "run_finished",
        });

        expect(JSON.parse(lines[0]!)).toMatchObject({
            attempts: 3,
            category: "internal_server_error",
            code: "model_backend_failure",
            event: "provider_inference_failed",
            level: "error",
            message:
                'provider:inference-failed sessionId=session-1 runId=run-1 providerId=bedrock modelId=openai.gpt-5.6-sol category=internal_server_error status=502 code=model_backend_failure requestId=request-123 reason="Internal server error"',
            providerId: "bedrock",
            requestId: "request-123",
            requestedModelId: "openai.gpt-5.6-sol",
            runId: "run-1",
            sessionId: "session-1",
            status: 502,
            upstreamMessage: "Internal server error",
        });
    });
});
