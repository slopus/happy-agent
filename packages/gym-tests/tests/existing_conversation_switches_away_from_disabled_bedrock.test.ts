import { expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

it("continues the existing conversation after its old Bedrock provider is disabled", async () => {
    const gym = await createGym({
        providerId: "bedrock",
        modelId: "openai/gpt-5.6-sol",
        homeFiles: {
            "happy/config/happy.toml": [
                "[providers]",
                "default_enable = false",
                "[providers.bedrock]",
                "enabled = true",
                'include_models = ["openai/gpt-5.6-sol"]',
                "[providers.bee_dev]",
                'type = "bedrock"',
                "enabled = true",
                'include_models = ["openai/gpt-5.6-sol"]',
            ].join("\n"),
        },
        inference: [
            { content: [{ type: "text", text: "ORIGINAL_BOT_ANSWER" }] },
            { content: [{ type: "text", text: "REPLACEMENT_BOT_ANSWER" }] },
            { content: [{ type: "text", text: "FOLLOW_UP_BOT_ANSWER" }] },
        ],
    });
    try {
        submit(gym, "Remember our existing work.");
        await gym.terminal.waitForText("ORIGINAL_BOT_ANSWER", 30_000);

        // Selecting a model changes the next message's mode, not the saved agent settings.
        // Disable the old route before sending that message, while Base still references it.
        submit(gym, "/model");
        await gym.terminal.waitUntil(
            (screen) => screen.text.includes("Choose Model") && screen.text.includes("Bee Dev"),
            "the replacement provider in the model picker",
            30_000,
        );
        gym.terminal.press("down");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Choose Reasoning");
        gym.terminal.press("enter");
        await gym.terminal.waitUntil(
            (screen) =>
                !screen.text.includes("Choose Reasoning") &&
                screen.text.includes("Ask Happy Terminal to do anything"),
            "the composer after choosing the replacement",
        );

        await disableOldProvider(gym);
        submit(gym, "Continue our existing work on Bee Dev.");
        const switched = await gym.terminal.waitForText("REPLACEMENT_BOT_ANSWER", 30_000);
        expect(switched.text).toContain("ORIGINAL_BOT_ANSWER");
        expect(switched.text).not.toContain('Provider "bedrock" is disabled.');

        submit(gym, "Continue once more.");
        await gym.terminal.waitForText("FOLLOW_UP_BOT_ANSWER", 30_000);
        const requests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(requests.map((request) => request.providerId)).toEqual([
            "bedrock",
            "bee_dev",
            "bee_dev",
        ]);
        expect(new Set(requests.map((request) => request.options.sessionId)).size).toBe(1);
        // The model-switch handoff must retain knowledge of the archived conversation.
        expect(JSON.stringify(requests[1]?.context.messages)).toContain("ORIGINAL_BOT_ANSWER");
        expect(JSON.stringify(requests[2]?.context.messages)).toContain("REPLACEMENT_BOT_ANSWER");
    } finally {
        await gym.dispose();
    }
}, 90_000);

function submit(gym: Gym, text: string): void {
    gym.terminal.type(text);
    gym.terminal.press("enter");
}

async function disableOldProvider(gym: Gym): Promise<void> {
    await gym.runInContainer("node", [
        "--input-type=module",
        "--eval",
        `
        import { readFile } from "node:fs/promises";
        import { request } from "node:http";
        import { join } from "node:path";
        const directory = join(process.env.HOME, ".happy", "agent");
        const token = (await readFile(join(directory, "token"), "utf8")).trim();
        await new Promise((resolve, reject) => {
            const call = request({
                socketPath: join(directory, "server.sock"),
                method: "PATCH",
                path: "/v0/config",
                headers: { authorization: "Bearer " + token, "content-type": "application/json" },
            }, (response) => {
                response.resume();
                response.on("error", reject);
                response.on("end", () => response.statusCode === 200
                    ? resolve()
                    : reject(new Error("Provider disable failed: " + response.statusCode)));
            });
            call.on("error", reject);
            call.end(JSON.stringify({ providers: { bedrock: { enabled: false } } }));
        });
    `,
    ]);
}
