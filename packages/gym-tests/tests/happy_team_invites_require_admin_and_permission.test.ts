import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

const toolName = "invite_happy_team_member";
const input = { team_id: "org_team", email: "person@example.com" };

describe("Happy team email invitations", () => {
    it.each(["human", "non-admin bot"] as const)(
        "does not expose invitations to a %s",
        async (kind) => {
            const gym = await createAgentGym({
                permissionMode: "full_access",
                inference: [
                    { content: [{ type: "tool_call", name: toolName, arguments: input }] },
                    { content: [{ type: "text", text: "The invitation tool is unavailable." }] },
                ],
            });
            running.push(gym);
            const agentId =
                kind === "human"
                    ? gym.defaultSessionId
                    : (await gym.client.createBot({ name: "Helper", isAdmin: false })).bot.agent.id;
            await gym.send("Invite person@example.com to org_team if authorized.", {
                sessionId: agentId,
                permissionMode: "full_access",
            });
            const offered = gym.inference.requests
                .filter((request) => request.sessionId === agentId)
                .flatMap((request) => request.tools.map((tool) => tool.name));
            expect(offered).not.toContain(toolName);
            expect(gym.errors).toEqual([]);
        },
    );

    it.each(["read_only", "workspace_write", "auto-deny", "auto-allow", "full_access"] as const)(
        "enforces %s before attempting Cloud authentication",
        async (mode) => {
            const permissionMode = mode.startsWith("auto")
                ? ("auto" as const)
                : (mode as "read_only" | "workspace_write" | "full_access");
            let adminId = "";
            let called = false;
            const reviews: string[] = [];
            const gym = await createAgentGym({
                permissionMode,
                inference(request) {
                    if (request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "<title>Invite</title>" }] };
                    if (request.sessionId !== adminId) {
                        reviews.push(JSON.stringify(request.messages));
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `<review><outcome>${mode === "auto-allow" ? "allow" : "deny"}</outcome><risk>medium</risk><user_authorization>high</user_authorization><rationale>Scripted invitation review.</rationale></review>`,
                                },
                            ],
                        };
                    }
                    if (called)
                        return {
                            content: [{ type: "text", text: "Invitation attempt finished." }],
                        };
                    called = true;
                    return { content: [{ type: "tool_call", name: toolName, arguments: input }] };
                },
            });
            running.push(gym);
            adminId = (await gym.client.listBots()).bots.find(
                (bot) => bot.isAdmin && bot.status === "active",
            )!.agent.id;
            await gym.send("Invite person@example.com to Happy team org_team as a member.", {
                sessionId: adminId,
                permissionMode,
            });
            const results = JSON.stringify(gym.inference.toolResults());
            if (mode === "auto-allow" || mode === "full_access") {
                expect(results).toContain("Cloud is not authenticated");
            } else {
                expect(results).not.toContain("Cloud is not authenticated");
                if (mode === "auto-deny") {
                    expect(results).toMatch(/denied|permission/i);
                } else {
                    expect(results).toContain("acts outside the sandbox");
                    expect(results).toContain(
                        mode === "read_only"
                            ? "unavailable in Read only mode"
                            : "unavailable in Workspace write mode",
                    );
                }
            }
            expect(reviews).toHaveLength(mode.startsWith("auto") ? 1 : 0);
            if (reviews.length > 0) {
                expect(reviews[0]).toContain("person@example.com");
                expect(reviews[0]).toContain("org_team");
                expect(reviews[0]).toContain("external Happy Cloud API");
            }
            expect((await gym.client.getCloud()).cloud.status).toBe("disconnected");
            expect(gym.errors).toEqual([]);
        },
    );
});
