import { describe, expect, it } from "vitest";
import { parseSupervisorPolicy } from "../SupervisorPolicy.js";

const service = {
    root: "/private/execution/root",
    cwd: ".",
    inputs: [{ source: "/workspace/src", destination: "src" }],
    scratch: ["dist"],
    cgroupParent: "/sys/fs/cgroup/delegated",
    executionId: "abcdefghijklmnop",
    controllerPid: 42,
    bridgeSocket: "/private/execution/bridge",
    bridgeToken: "a".repeat(64),
    port: 4187,
    memoryMiB: 1024,
    processes: 64,
    outbound: [],
};

describe("native service policy", () => {
    const parse = (change: object) =>
        parseSupervisorPolicy({
            mode: "read_only",
            network: { egress: false, localBinding: true },
            service: { ...service, ...change },
        });
    it("carries a separate mandatory boundary without changing the shell policy shape", () => {
        expect(parse({}).service).toEqual(service);
        expect(
            parseSupervisorPolicy({ mode: "auto", network: { egress: false, localBinding: false } })
                .service,
        ).toBeUndefined();
    });
    it.each([
        { inputs: [] },
        { memoryMiB: 127 },
        { memoryMiB: 1025 },
        { processes: 0 },
        { processes: 65 },
        { port: 80 },
        { bridgeToken: "guessable" },
        { executionId: "../../other" },
        { controllerPid: 1 },
        { environment: { SECRET: "no" } },
        { outbound: [{ hostname: "example.com", port: 0 }] },
    ])("rejects an invalid service boundary %j", (change) => expect(() => parse(change)).toThrow());
});
