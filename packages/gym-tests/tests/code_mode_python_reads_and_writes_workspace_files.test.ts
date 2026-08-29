import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("Code Mode workspace filesystem", () => {
    it("reads fixtures and writes files through the Python tool", async () => {
        const gym = await createGym({
            files: { "input.txt": "hello from the workspace\n" },
            homeFiles: {
                "Happy/Config/happy.toml": "[feature.codemode]\nenabled = true\n",
            },
            inference(request, callIndex) {
                const transcript = JSON.stringify(request.context.messages);
                if (callIndex === 0) {
                    expect(request.context.systemPrompt).toContain("Code Mode");
                    expect(request.context.tools?.map((tool) => tool.name)).toEqual(["python"]);
                    return {
                        content: [
                            {
                                arguments: {
                                    code: `from pathlib import Path
source = Path("input.txt")
destination = Path("generated/result.txt")
destination.parent.mkdir()
with open(source) as stream:
    value = stream.read().strip()
with open(destination, "w") as stream:
    stream.write(value.upper() + "!")
print(destination.read_text())
destination.stat().st_size`,
                                },
                                id: "codemodefilesystem",
                                name: "python",
                                type: "toolCall",
                            },
                        ],
                    };
                }
                if (callIndex === 1) {
                    expect(transcript).toContain("stdout:\\nHELLO FROM THE WORKSPACE!");
                    expect(transcript).toContain("result:\\n25");
                    return {
                        content: [{ text: "CODE_MODE_FILESYSTEM_READY", type: "text" }],
                    };
                }
                throw new Error(`Unexpected Code Mode inference ${callIndex}.`);
            },
        });
        running.add(gym);

        gym.terminal.type("Read input.txt and save an uppercase result under generated/.");
        gym.terminal.press("enter");

        const screen = await gym.terminal.waitForText("CODE_MODE_FILESYSTEM_READY", 30_000);
        expect(screen.text).toContain("CODE_MODE_FILESYSTEM_READY");
        await expect(gym.readFile("generated/result.txt")).resolves.toBe(
            "HELLO FROM THE WORKSPACE!",
        );
    });
});
