import { createGym, type Gym } from "@slopus/happy-terminal-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe.skipIf(process.platform !== "win32")("native Windows accepted steering", () => {
    it("keeps consumed steering out of the composer after its successor run finishes", async () => {
        let releaseFirst!: () => void;
        const firstPending = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let firstStarted = false;
        const steering = "Apply this follow-up exactly once.";
        const gym = await createGym({
            mode: "native-windows",
            permissionMode: "read_only",
            timeoutMs: 90_000,
            environment: {
                HAPPY_WINDOWS_SANDBOX_HOME: process.env.HAPPY_WINDOWS_SANDBOX_HOME ?? "",
            },
            async inference(request, callIndex) {
                if (callIndex === 0) {
                    firstStarted = true;
                    await firstPending;
                    return { content: [{ type: "text", text: "FIRST_RESPONSE_COMPLETE" }] };
                }
                expect(callIndex).toBe(1);
                const users = request.context.messages.filter((message) => message.role === "user");
                expect(JSON.stringify(users).split(steering)).toHaveLength(2);
                return { content: [{ type: "text", text: "STEERING_RESPONSE_COMPLETE" }] };
            },
        });
        running.add(gym);
        gym.terminal.type("Start the first response.");
        gym.terminal.press("enter");
        await gym.terminal.waitUntil(
            (screen) => firstStarted && screen.text.includes("esc to interrupt"),
            "the first inference to remain active",
            30_000,
        );
        gym.terminal.type(steering);
        gym.terminal.press("enter");
        await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes(steering) &&
                screen.text.includes("Messages to be submitted after next tool call"),
            "steering to be accepted while inference remains active",
            15_000,
        );
        releaseFirst();
        const completed = await gym.terminal.waitUntil(
            (screen) =>
                screen.text.includes("STEERING_RESPONSE_COMPLETE") &&
                screen.text.includes("Ask Happy Terminal to do anything") &&
                !screen.text.includes("esc to interrupt"),
            "consumed steering to finish with an empty, idle composer",
            30_000,
        );
        expect(completed.text.split(steering)).toHaveLength(2);
        expect(gym.inference.handlerFailures).toEqual([]);
    }, 180_000);
});
