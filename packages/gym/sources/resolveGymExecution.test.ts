import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveGymExecution } from "./resolveGymExecution.js";

beforeEach(() => {
    vi.stubEnv("HAPPY_TERMINAL_GYM_EXECUTION", "");
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("resolveGymExecution", () => {
    it("uses just-bash locally by default", () => {
        expect(resolveGymExecution({})).toBe("local");
        expect(resolveGymExecution({ mode: "just-bash" })).toBe("local");
        expect(resolveGymExecution({ entrypoint: ["bash", "custom-entrypoint.sh"] })).toBe("local");
    });

    it("uses Docker only when the gym or suite explicitly requests it", () => {
        expect(resolveGymExecution({ mode: "docker" })).toBe("docker");
        vi.stubEnv("HAPPY_TERMINAL_GYM_EXECUTION", "docker");
        expect(resolveGymExecution({})).toBe("docker");
    });

    it("rejects Docker-only options in a local gym", () => {
        expect(() => resolveGymExecution({ dockerSocket: true })).toThrow(
            'Gym option "dockerSocket" requires mode: "docker".',
        );
        expect(() => resolveGymExecution({ image: "happy-terminal-gym:test" })).toThrow(
            'Gym option "image" requires mode: "docker".',
        );
    });
});
