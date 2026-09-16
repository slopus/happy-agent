import { createGym, type GymInferenceResponse } from "@slopus/happy-terminal-gym";
import { expect, it } from "vitest";

const picture =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

it("lets an admin bot set a peer's picture and removes that peer from the missing-avatar listing", async () => {
    let mainCalls = 0;
    let chiefCalls = 0;
    let targetId = "";
    const gym = await createGym({
        mode: "docker",
        inference(request): GymInferenceResponse {
            const history = JSON.stringify(request.context.messages);
            const isChief = request.context.systemPrompt?.includes(
                'You are the persistent bot named "Chief of Staff"',
            );
            if (isChief) {
                chiefCalls += 1;
                if (chiefCalls === 1) {
                    return call("missing-before", "list_bots", { hasAvatar: false });
                }
                if (chiefCalls === 2) {
                    expect(history).toContain("Avatar Target");
                    expect(history).toContain("no avatar");
                    return call("write-picture", "exec_command", {
                        cmd: `printf '%s' '${picture}' | base64 -d > picture.png`,
                    });
                }
                if (chiefCalls === 3) {
                    return call("set-peer-avatar", "set_bot_avatar", {
                        path: "picture.png",
                        botId: targetId,
                    });
                }
                if (chiefCalls === 4) {
                    expect(history).toContain("The bot's avatar is set.");
                    return call("missing-after", "list_bots", { hasAvatar: false });
                }
                expect(JSON.stringify(request.context.messages.at(-1))).toContain("No bots found.");
                return { content: [{ type: "text", text: "ADMIN_AVATAR_COMPLETE" }] };
            }

            mainCalls += 1;
            if (mainCalls === 1) {
                return call("create-target", "create_bot", { name: "Avatar Target" });
            }
            if (mainCalls === 2) return call("roster", "list_bots", {});
            if (mainCalls === 3) {
                targetId = history.match(/Avatar Target — id ([a-z0-9]+)/u)?.[1] ?? "";
                const chiefId = history.match(/Chief of Staff — id ([a-z0-9]+)/u)?.[1];
                expect(targetId).not.toBe("");
                expect(chiefId).toBeDefined();
                return call("ask-chief", "send_bot_message", {
                    botId: chiefId,
                    text: `Set an avatar for bot ${targetId} from a picture in your own folder, then list bots without avatars.`,
                });
            }
            return { content: [{ type: "text", text: "AVATAR_REQUEST_SENT" }] };
        },
    });
    try {
        gym.terminal.type(
            "Create Avatar Target and ask Chief of Staff to give it an avatar and check which bots still need pictures.",
        );
        gym.terminal.press("enter");
        await gym.terminal.waitForText("AVATAR_REQUEST_SENT", 30_000);
        await expect.poll(() => chiefCalls, { timeout: 30_000 }).toBe(5);
        const chiefRequests = gym.inference.requests.filter((request) =>
            request.context.systemPrompt?.includes(
                'You are the persistent bot named "Chief of Staff"',
            ),
        );
        const lastResult = JSON.stringify(chiefRequests.at(-1)?.context.messages.at(-1));
        expect(lastResult).toContain("No bots found.");
        expect(JSON.stringify(chiefRequests)).toContain("The bot's avatar is set.");
    } finally {
        await gym.dispose();
    }
}, 60_000);

function call(id: string, name: string, args: Record<string, unknown>): GymInferenceResponse {
    return { content: [{ type: "toolCall", id, name, arguments: args }] };
}
