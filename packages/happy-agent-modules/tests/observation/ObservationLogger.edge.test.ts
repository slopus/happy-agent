import { describe, expect, it } from "vitest";

import type { LogContext } from "@steve.kite/stdlib";

import { createObservationLogger } from "../../sources/observation/impl/createObservationLogger.js";
import type { RotatingFileWriter } from "../../sources/observation/impl/RotatingFileWriter.js";

type RecordedWriter = Pick<RotatingFileWriter, "write"> & {
    readonly lines: string[];
};

function writer(): RecordedWriter {
    const lines: string[] = [];
    return {
        lines,
        write(line: string) {
            lines.push(line);
        },
    };
}

function logger(
    destination: RecordedWriter,
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
) {
    return createObservationLogger(destination as unknown as RotatingFileWriter, level);
}

describe("createObservationLogger edge cases", () => {
    it("keeps only finite scalar context fields", () => {
        const destination = writer();
        const log = logger(destination, "trace");

        log.info(
            {
                keepString: "value",
                keepNumber: 3,
                keepBoolean: true,
                skipNaN: Number.NaN,
                skipInfinity: Number.POSITIVE_INFINITY,
                skipObject: { nested: true },
                skipArray: ["nested"],
                skipNull: null,
            },
            "hello",
        );

        const record = JSON.parse(destination.lines[0] ?? "{}") as Record<string, unknown>;
        expect(record).toMatchObject({
            keepString: "value",
            keepNumber: 3,
            keepBoolean: true,
            msg: "hello",
        });
        expect(record).not.toHaveProperty("skipNaN");
        expect(record).not.toHaveProperty("skipInfinity");
        expect(record).not.toHaveProperty("skipObject");
        expect(record).not.toHaveProperty("skipArray");
        expect(record).not.toHaveProperty("skipNull");
    });

    it("caps scalar context fields at 64", () => {
        const destination = writer();
        const log = logger(destination, "info");
        const context: Record<string, string> = {};
        for (let index = 0; index < 65; index += 1) {
            context[`field${index}`] = `${index}`;
        }

        log.info(context, "bounded");

        const record = JSON.parse(destination.lines[0] ?? "{}") as Record<string, unknown>;
        expect(Object.keys(record).filter((key) => key.startsWith("field"))).toHaveLength(64);
        expect(record).toHaveProperty("field0", "0");
        expect(record).toHaveProperty("field63", "63");
        expect(record).not.toHaveProperty("field64");
    });

    it("formats supported argument kinds without throwing", () => {
        const destination = writer();
        const log = logger(destination, "info");
        const failure = new Error("boom");
        failure.stack = "Error: boom\n    at example.ts:1:1";

        log.info({} as LogContext, "text", { value: 1 }, failure, undefined, 7n, Symbol("s"));

        const record = JSON.parse(destination.lines[0] ?? "{}") as Record<string, unknown>;
        expect(record.msg).toBe(
            'text {"value":1} Error: boom\n    at example.ts:1:1 undefined 7 Symbol(s)',
        );
    });

    it("records an Error stack trace instead of hiding it behind the message", () => {
        const destination = writer();
        const log = logger(destination, "warn");
        const failure = new Error("relay failed");
        failure.stack = "Error: relay failed\n    at openRelay (cloud.ts:42:7)";

        log.warn({}, "cloud:keys:error reason=unexpected", failure);

        const record = JSON.parse(destination.lines[0] ?? "{}") as Record<string, unknown>;
        expect(record.msg).toBe(
            "cloud:keys:error reason=unexpected Error: relay failed\n" +
                "    at openRelay (cloud.ts:42:7)",
        );
    });

    it("truncates a very long formatted message", () => {
        const destination = writer();
        const log = logger(destination, "info");

        log.info({}, "x".repeat(100_000));

        const record = JSON.parse(destination.lines[0] ?? "{}") as Record<string, unknown>;
        expect(typeof record.msg).toBe("string");
        expect((record.msg as string).length).toBe(65_536);
    });

    it.each([
        ["trace", "trace"],
        ["debug", "debug"],
        ["info", "info"],
        ["warn", "warn"],
        ["error", "error"],
        ["fatal", "fatal"],
    ] as const)("honors the configured %s level", (level, expectedLevel) => {
        const destination = writer();
        const log = logger(destination, level);

        log.trace({}, "trace");
        log.debug({}, "debug");
        log.info({}, "info");
        log.warn({}, "warn");
        log.error({}, "error");
        log.fatal({}, "fatal");

        const records = destination.lines.map(
            (line) => JSON.parse(line) as Record<string, unknown>,
        );
        const minimum = {
            trace: 10,
            debug: 20,
            info: 30,
            warn: 40,
            error: 50,
            fatal: 60,
        }[expectedLevel];
        expect(records.map((record) => record.level)).toEqual(
            [10, 20, 30, 40, 50, 60].filter((value) => value >= minimum),
        );
    });

    it("does not let a throwing context getter break the work being observed", () => {
        const destination = writer();
        const log = logger(destination, "info");
        const context = Object.defineProperty({}, "unsafe", {
            enumerable: true,
            get() {
                throw new Error("getter failed");
            },
        }) as LogContext;

        expect(() => log.info(context, "still useful")).not.toThrow();
        expect(destination.lines).toHaveLength(1);
        expect(JSON.parse(destination.lines[0] ?? "{}")).toMatchObject({
            msg: "still useful",
        });
    });
});
