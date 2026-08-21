import { afterEach, describe, expect, it, vi } from "vitest";

import { installCliFailureReporting } from "./installCliFailureReporting.js";

afterEach(() => {
    process.exitCode = undefined;
});

describe("installCliFailureReporting", () => {
    it("reports uncaught failures before exiting", () => {
        const { listeners, target } = fakeProcess();
        const reportFailure = vi.fn();

        installCliFailureReporting(target, reportFailure);
        expect(() => listeners.uncaughtException?.(new Error("Boom."))).toThrow("exit 1");

        expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ message: "Boom." }));
    });

    it("reports unhandled rejections the same way", () => {
        const { listeners, target } = fakeProcess();
        const reportFailure = vi.fn();

        installCliFailureReporting(target, reportFailure);
        expect(() => listeners.unhandledRejection?.(new Error("Dropped."))).toThrow("exit 1");

        expect(reportFailure).toHaveBeenCalledWith(
            expect.objectContaining({ message: "Dropped." }),
        );
    });

    it("stops reporting once a failure arrives while reporting the first one", () => {
        const { listeners, target } = fakeProcess();
        const reportFailure = vi.fn(() => {
            throw new Error("The terminal went away.");
        });

        installCliFailureReporting(target, reportFailure);
        expect(() => listeners.uncaughtException?.(new Error("Boom."))).toThrow("exit 1");
        expect(() => listeners.uncaughtException?.(new Error("Again."))).toThrow("exit 1");

        expect(reportFailure).toHaveBeenCalledTimes(1);
    });
});

function fakeProcess(): {
    listeners: Partial<
        Record<"uncaughtException" | "unhandledRejection", (error: unknown) => void>
    >;
    target: Parameters<typeof installCliFailureReporting>[0];
} {
    const listeners: Partial<
        Record<"uncaughtException" | "unhandledRejection", (error: unknown) => void>
    > = {};
    return {
        listeners,
        target: {
            exit: (code: number) => {
                throw new Error(`exit ${String(code)}`);
            },
            on: (event, listener) => {
                listeners[event] = listener;
            },
        },
    };
}
