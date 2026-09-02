import { afterEach, describe, expect, it, vi } from "vitest";

import { createGym } from "./createGym.js";

afterEach(() => {
    vi.unstubAllEnvs();
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
});
