import { afterEach, describe, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

const RAW_UPSTREAM_REJECTION =
    'Error 401 "Invalid or expired credentials (auth_kind=bearer, x_xai_token_auth=xai-grok-cli, upstream=PermissionDenied, reason=no auth context)"';

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("expired credentials", () => {
    it("explains how to sign in again instead of printing the upstream diagnostic", async () => {
        const gym = await createGym({
            cols: 160,
            inference: [
                {
                    content: [],
                    errorMessage: RAW_UPSTREAM_REJECTION,
                    providerError: { type: "authentication" },
                    stopReason: "error",
                },
            ],
        });
        running.add(gym);

        gym.terminal.type("Ask for something while signed out.");
        gym.terminal.press("enter");
        const screen = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("credentials have expired") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                !snapshot.text.includes("esc to interrupt"),
            "the expired credential notice",
        );

        if (screen.text.includes("auth_kind=bearer") || screen.text.includes("PermissionDenied")) {
            throw new Error("The raw upstream diagnostic string reached the transcript.");
        }
    });

    it("still explains the failure when the provider leaves it unclassified", async () => {
        const gym = await createGym({
            cols: 160,
            inference: [
                {
                    content: [],
                    errorMessage: RAW_UPSTREAM_REJECTION,
                    providerError: { type: "unclassified" },
                    stopReason: "error",
                },
            ],
        });
        running.add(gym);

        gym.terminal.type("Ask again with an unclassified rejection.");
        gym.terminal.press("enter");
        const screen = await gym.terminal.waitUntil(
            (snapshot) =>
                snapshot.text.includes("credentials have expired") &&
                snapshot.text.includes("Ask Happy Terminal to do anything") &&
                !snapshot.text.includes("esc to interrupt"),
            "the expired credential notice for an unclassified error",
        );

        if (screen.text.includes("auth_kind=bearer") || screen.text.includes("PermissionDenied")) {
            throw new Error("The raw upstream diagnostic string reached the transcript.");
        }
    });
});
