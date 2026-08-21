import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("restricted non-git home project", () => {
    it("starts the TUI from the non-Git home directory", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: [
                "/bin/sh",
                "-lc",
                "cd /home/happy-terminal && exec node /app/packages/happy-terminal/dist/main.js",
            ],
            homeFiles: {
                "README.md": "A home directory without a Git marker.\n",
            },
            inference: [
                {
                    content: [{ text: "The home project reached inference.", type: "text" }],
                },
            ],
            permissionMode: "workspace_write",
        });
        running.add(gym);

        gym.terminal.type("Confirm the home project is available.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText(
            "The home project reached inference.",
            30_000,
        );
        expect(screen.text).toContain("The home project reached inference.");
    }, 120_000);

    it("reaches inference when ancestor marker paths are private", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: [
                "/bin/sh",
                "-lc",
                "cd /home/happy-terminal/project && exec node /app/packages/happy-terminal/dist/main.js",
            ],
            homeFiles: {
                "project/README.md": "A project without a Git marker.\n",
            },
            inference: [
                {
                    content: [{ text: "The agent turn reached inference.", type: "text" }],
                },
            ],
            permissionMode: "workspace_write",
        });
        running.add(gym);

        gym.terminal.type("Confirm this project is available.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("The agent turn reached inference.", 30_000);
        expect(screen.text).toContain("The agent turn reached inference.");

        const agentRequests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        expect(agentRequests).toHaveLength(1);
        expect(agentRequests[0]?.context.messages.at(-1)).toMatchObject({
            content: [{ text: "Confirm this project is available.", type: "text" }],
            role: "user",
        });
    }, 120_000);

    it("starts from a readable folder whose Git marker is inaccessible", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: [
                "/bin/sh",
                "-lc",
                "cd /home/happy-terminal/project && exec node /app/packages/happy-terminal/dist/main.js",
            ],
            homeFiles: {
                "project/.git": { content: "not usable Git metadata\n", mode: 0o000 },
                "project/README.md": "A project with inaccessible Git metadata.\n",
            },
            inference: [
                {
                    content: [{ text: "The invalid Git project reached inference.", type: "text" }],
                },
            ],
            permissionMode: "workspace_write",
        });
        running.add(gym);

        gym.terminal.type("Confirm this folder is still a project.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText(
            "The invalid Git project reached inference.",
            30_000,
        );
        expect(screen.text).toContain("The invalid Git project reached inference.");
    }, 120_000);
});
