import { describe, expect, it } from "vitest";

import { readRunnerOptions } from "../sources/runner/readRunnerOptions.js";

const TOKEN = "a".repeat(43);

describe("runner options", () => {
    it("connects to an https daemon and forgets the token it was given", () => {
        const environment: NodeJS.ProcessEnv = { HAPPY_RUNNER_TOKEN: TOKEN };
        const options = readRunnerOptions(
            ["--endpoint", "https://node.example.ts.net", "--home", "/srv/work"],
            environment,
        );
        expect(options.url).toBe("wss://node.example.ts.net/v0/runners/connect");
        expect(options.tailcat).toBeUndefined();
        expect(options.home).toBe("/srv/work");
        expect(environment.HAPPY_RUNNER_TOKEN).toBeUndefined();
    });

    it("dials a standalone daemon through its Tailcat address and port", () => {
        const tailcat = readRunnerOptions(["--endpoint", "tailcat:tcAbc_def-123:24780"], {
            HAPPY_RUNNER_TOKEN: TOKEN,
        });
        expect(tailcat.tailcat).toEqual({ address: "tcAbc_def-123", port: 24780 });
        expect(tailcat.url).toBe("ws://server.tailcat/v0/runners/connect");
        expect(
            readRunnerOptions([], {
                HAPPY_RUNNER_ENDPOINT: "tailcat:tcAbc",
                HAPPY_RUNNER_TOKEN: TOKEN,
            }).tailcat,
        ).toEqual({ address: "tcAbc", port: 24779 });
    });

    it("refuses an endpoint that is not a Tailcat address", () => {
        for (const endpoint of ["tailcat:", "tailcat:abc", "tailcat:tcAbc:0", "tailcat:tc a"]) {
            expect(() =>
                readRunnerOptions(["--endpoint", endpoint], { HAPPY_RUNNER_TOKEN: TOKEN }),
            ).toThrow(/not a Tailcat address/u);
        }
    });
});
