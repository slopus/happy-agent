import { spawn } from "@lydell/node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGym } from "./createGym.js";

vi.mock("@lydell/node-pty", () => ({ spawn: vi.fn() }));

afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});

describe("createGym inference boundaries", () => {
    it("requires the host live-test opt-in before starting live inference", async () => {
        vi.stubEnv("HAPPY_TERMINAL_LIVE_TEST", "");

        await expect(createGym({ liveInference: true })).rejects.toThrow(
            "Live Gym inference requires the HAPPY_TERMINAL_LIVE_TEST=1 opt-in.",
        );
    });

    it("does not let a scenario bypass liveInference through an environment override", async () => {
        await expect(
            createGym({ environment: { HAPPY_TERMINAL_GYM_LIVE_INFERENCE: "1" } }),
        ).rejects.toThrow(
            "Gym environment cannot set HAPPY_TERMINAL_GYM_LIVE_INFERENCE; use the liveInference option.",
        );
    });
    it.skipIf(process.platform !== "win32")(
        "rejects unconfigured native state before starting a process",
        async () => {
            await expect(
                createGym({
                    mode: "native-windows",
                    permissionMode: "read_only",
                    environment: { HAPPY_WINDOWS_SANDBOX_HOME: "" },
                }),
            ).rejects.toThrow("absolute HAPPY_WINDOWS_SANDBOX_HOME");
            expect(spawn).not.toHaveBeenCalled();
        },
    );
});
