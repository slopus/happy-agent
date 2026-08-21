import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildGymImage } from "./buildGymImage.js";
import { inspectGymImage } from "./inspectGymImage.js";

vi.mock("./inspectGymImage.js", () => ({
    inspectGymImage: vi.fn(),
}));

const mockedInspectGymImage = vi.mocked(inspectGymImage);

beforeEach(() => {
    vi.stubEnv("HAPPY_TERMINAL_GYM_SKIP_BUILD", "1");
    mockedInspectGymImage.mockReset();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("buildGymImage", () => {
    it("preserves the original inspection failure when building is disabled", async () => {
        const inspectionError = new Error("Gym image is missing.");
        mockedInspectGymImage.mockRejectedValue(inspectionError);

        await expect(buildGymImage("happy-terminal-gym:missing-test", "/repository")).rejects.toBe(
            inspectionError,
        );
        expect(mockedInspectGymImage).toHaveBeenCalledOnce();
    });
});
