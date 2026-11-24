import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";

const RELAY = "https://push.cluster-fluster.com/v1/push/send";
const PHONE = "7b0c2d2e-5a51-4c0e-9d5f-3a1f6c0b9e42";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    vi.unstubAllGlobals();
}, 30_000);

/** Stand in for Happy's relay, so no scenario reaches the real one, and keep what it was sent. */
function stubRelay(): Record<string, unknown>[] {
    const requests: Record<string, unknown>[] = [];
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        if (String(input) !== RELAY) return nativeFetch(input, init);
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(Response.json({ data: [{ status: "ok", id: "ticket-1" }] }));
    });
    return requests;
}

async function registerPhone(gym: AgentGym): Promise<void> {
    await gym.http.ok("PUT", `/v0/cloud/push/registrations/${PHONE}`, {
        token: "HappyPushToken[phone00000000000000001]",
        platform: "ios",
        appId: "com.ex3ndr.happy",
    });
}

const notify = (callId: string, input: Record<string, unknown>) => ({
    arguments: input,
    callId,
    name: "send_push_notification",
    type: "tool_call" as const,
});
const text = (value: string): GymTurn => ({ content: [{ text: value, type: "text" }] });
const naming = (request: GymInferenceRequest) => request.sessionId.startsWith("naming:");

describe("an agent tells its person what happened, on their phone", () => {
    it("sends the last call of a turn once the agent is idle, in a read-only agent too", async () => {
        const relay = stubRelay();
        let turns = 0;
        const gym = await createAgentGym({
            permissionMode: "read_only",
            inference: (request) => {
                if (naming(request)) return text("<title>Preview</title><slug>preview</slug>");
                turns += 1;
                if (turns === 1) {
                    return {
                        content: [
                            notify("firstcall", {
                                title: "Looking into the failing deploy",
                                subtitle: "Reading the logs",
                            }),
                            notify("secondcall", {
                                title: "iOS preview 24 uploaded; prod is blocked",
                                subtitle: "Prod needs build number 164 committed on main first",
                            }),
                        ],
                    };
                }
                if (turns === 2) return text("Uploaded.");
                if (turns === 3) {
                    return {
                        content: [
                            notify("thirdcall", { title: "Scratch volume down to 16 GB free" }),
                        ],
                    };
                }
                return text("Nothing else.");
            },
        });
        running.add(gym);
        await registerPhone(gym);
        const health = await gym.http.ok<{ instanceId: string }>("GET", "/v0/health");

        await gym.send("Ship the preview.");
        await gym.waitUntil(() => relay.length === 1 || undefined, "the relay to be asked once");

        expect(gym.inference.lastTools()).toContain("send_push_notification");
        expect(gym.inference.toolResults().map((result) => result.text)).toEqual([
            '{"ok":true}',
            '{"ok":true}',
        ]);
        expect(relay).toEqual([
            {
                to: "HappyPushToken[phone00000000000000001]",
                title: "iOS preview 24 uploaded; prod is blocked",
                body: "Prod needs build number 164 committed on main first",
                data: {
                    kind: "happy.cloud.push.v1",
                    instanceId: health.instanceId,
                    userId: "standalone",
                    agentId: gym.defaultSessionId,
                    notificationId: expect.stringMatching(/^[a-z][a-z0-9]{23}$/),
                },
                sound: "default",
                channelId: "messages",
                ttl: 300,
            },
        ]);

        // A second turn is a second notification, and a turn that says nothing sends nothing.
        await gym.send("How is the disk?");
        await gym.waitUntil(() => relay.length === 2 || undefined, "the relay to be asked again");
        await gym.send("Anything else?");
        expect(relay.map((request) => [request.title, request.body])).toEqual([
            [
                "iOS preview 24 uploaded; prod is blocked",
                "Prod needs build number 164 committed on main first",
            ],
            ["Scratch volume down to 16 GB free", ""],
        ]);
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("keeps a hidden helper from reaching the phone, even when it calls the tool anyway", async () => {
        const relay = stubRelay();
        let parentTurns = 0;
        let helperTools: readonly string[] | undefined;
        const gym = await createAgentGym({
            inference: (request) => {
                if (naming(request)) return text("<title>Sweep</title><slug>sweep</slug>");
                if (request.sessionId !== gym.defaultSessionId) {
                    const forced = request.messages.some((message) => message.role === "tool");
                    helperTools ??= request.tools.map((tool) => tool.name);
                    return forced
                        ? text("HELPER_DONE")
                        : {
                              content: [
                                  notify("helpercall", { title: "Removed 4.43 GB as usual" }),
                              ],
                          };
                }
                parentTurns += 1;
                if (parentTurns === 1) {
                    return {
                        content: [
                            {
                                arguments: {
                                    effort: "medium",
                                    model: "gym/model",
                                    provider: "gym",
                                    text: "Sweep the disk and report.",
                                    title: "Disk sweep",
                                },
                                callId: "createhelper",
                                name: "create_agent",
                                type: "tool_call" as const,
                            },
                        ],
                    };
                }
                return text("The helper is sweeping.");
            },
        });
        running.add(gym);
        await registerPhone(gym);

        await gym.send("Sweep the disk with a helper.", { wait: false });
        const helperResult = await gym.waitUntil(
            () => gym.inference.toolResults().find((result) => result.callId === "helpercall"),
            "the helper's call to be answered",
            20_000,
        );
        await gym.waitUntil(
            () =>
                JSON.stringify(gym.inference.requests.at(-1)?.messages).includes("HELPER_DONE") ||
                undefined,
            "the parent to hear the helper's report",
            20_000,
        );

        expect(helperTools).toBeDefined();
        expect(helperTools).not.toContain("send_push_notification");
        expect(helperResult.text).not.toContain('"ok"');
        expect(relay).toEqual([]);
    }, 60_000);

    it("stays quiet on a routine scheduled run and speaks on one that needs the person", async () => {
        const relay = stubRelay();
        const gym = await createAgentGym({
            inference: (request) => {
                if (naming(request)) return text("<title>Disk</title><slug>disk</slug>");
                const heard = JSON.stringify(request.messages.at(-1));
                const scheduled = (callId: string, message: string) => ({
                    arguments: {
                        input: { agent_id: gym.defaultSessionId, message, in: { seconds: 1 } },
                    },
                    callId,
                    name: "schedule_message",
                    type: "tool_call" as const,
                });
                if (request.messages.at(-1)?.role === "tool") return text("Noted.");
                if (heard.includes("Watch the disk.")) {
                    return { content: [scheduled("schedulefirst", "First scheduled check.")] };
                }
                if (heard.includes("First scheduled check.")) {
                    // Nothing new: the run schedules the next check and tells nobody.
                    return { content: [scheduled("schedulesecond", "Second scheduled check.")] };
                }
                if (heard.includes("Second scheduled check.")) {
                    return {
                        content: [
                            notify("scheduledcall", {
                                title: "Scratch volume down to 16 GB free",
                                subtitle:
                                    "Switching to the 400 GB volume still needs your approval",
                            }),
                        ],
                    };
                }
                return text("Nothing to do.");
            },
        });
        running.add(gym);
        await registerPhone(gym);

        await gym.send("Watch the disk.");
        // The first scheduled run has come and gone without a notification.
        await gym.waitUntil(
            () =>
                gym.inference.toolResults().some((result) => result.callId === "schedulesecond") ||
                undefined,
            "the first scheduled run to finish quietly",
            20_000,
        );
        expect(relay).toEqual([]);

        await gym.waitUntil(() => relay.length === 1 || undefined, "the scheduled run to notify");
        expect(relay.map((request) => [request.title, request.body])).toEqual([
            [
                "Scratch volume down to 16 GB free",
                "Switching to the 400 GB volume still needs your approval",
            ],
        ]);
    }, 60_000);
});
