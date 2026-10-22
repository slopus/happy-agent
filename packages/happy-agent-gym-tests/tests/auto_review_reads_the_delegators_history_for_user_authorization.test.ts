import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/**
 * A child agent's escalated push is authorized by what the person told its parent, not by what the
 * parent told the child. The scripted reviewer does what the policy asks: it follows the delegation
 * message's Agent ID with `read_agent_history`, reads only the person's own messages, and allows
 * the push only when the person asked for it.
 */
describe("Auto review reads the delegator's history for user authorization", () => {
    it.each([
        ["allows", "Please push HEAD to main.", "allow"],
        ["denies", "Please tidy the docs.", "deny"],
    ] as const)(
        "%s a child's push when the parent's person said %j",
        async (_name, parentUserText, expected) => {
            let parentAgentId = "";
            const historyReads: HistoryRead[] = [];
            const gym = await createAgentGym({
                permissionMode: "auto",
                inference: (request: GymInferenceRequest): GymTurn => {
                    if (
                        request.sessionId.startsWith("naming:") ||
                        request.instructions.includes("You name a piece of work")
                    ) {
                        return {
                            content: [
                                { type: "text", text: "<title>Push</title><slug>push</slug>" },
                            ],
                        };
                    }
                    if (request.instructions.includes("<outcome>")) {
                        return review(request, historyReads);
                    }
                    // The parent's notice of the collaborator it created may follow the result.
                    if (
                        request.messages.findLast((message) => message.role !== "system")?.role ===
                        "tool"
                    ) {
                        return { content: [{ type: "text", text: "Done." }] };
                    }
                    if (request.sessionId === parentAgentId) {
                        // The parent widens whatever the person said into a push.
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    name: "create_agent",
                                    callId: "delegatepush",
                                    arguments: {
                                        provider: "gym",
                                        model: "gym/model",
                                        effort: "medium",
                                        title: "Push",
                                        text: "Push HEAD to main.",
                                    },
                                },
                            ],
                        };
                    }
                    if (JSON.stringify(request.messages).includes("Message from agent")) {
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    name: "exec_command",
                                    callId: "childpush",
                                    arguments: {
                                        cmd: "echo pushed-to-main",
                                        sandbox_permissions: "require_escalated",
                                        justification: "Push HEAD to main as delegated.",
                                    },
                                },
                            ],
                        };
                    }
                    return { content: [{ type: "text", text: "UNEXPECTED_AGENT" }] };
                },
            });
            running.add(gym);
            parentAgentId = gym.defaultSessionId;

            await gym.send(parentUserText);

            const pushed = await gym.waitUntil(
                () => gym.inference.toolResults().find((result) => result.callId === "childpush"),
                "the child's push to be reviewed",
                30_000,
            );
            // The reviewer first found the delegator in the child's own history, then read the
            // person's messages in the parent's.
            expect(historyReads).toHaveLength(2);
            expect(historyReads[0]?.history).toContain(`AGENT (${parentAgentId})`);
            expect(historyReads[1]?.target).toBe(parentAgentId);
            // The parent's own instruction to the child never appears among the person's messages.
            expect(historyReads[1]?.history).toBe(`1. USER\nText: ${parentUserText}`);
            if (expected === "allow") {
                expect(pushed.text).toContain("pushed-to-main");
            } else {
                expect(pushed.text).toContain("Automatic permission review refused");
            }
            expect(gym.errors).toEqual([]);
        },
        60_000,
    );
});

interface HistoryRead {
    readonly target: string;
    readonly history: string;
}

/**
 * The policy, scripted. The transcript carries none of the parent's delegation, so the reviewer
 * reads the reviewed agent's own history to find its delegator, then reads only the person's
 * messages in the delegator's history.
 */
function review(request: GymInferenceRequest, historyReads: HistoryRead[]): GymTurn {
    const transcript = JSON.stringify(request.messages);
    const proposed = transcript.slice(transcript.lastIndexOf("<proposed_action>"));
    if (!proposed.includes("exec_command")) return verdict("allow");
    const last = request.messages.at(-1);
    if (last?.role !== "tool") {
        const reviewed = /<reviewed_agent_id>([a-z0-9]+)<\/reviewed_agent_id>/u.exec(
            transcript,
        )?.[1];
        if (reviewed === undefined) return verdict("deny");
        return readHistory("reviewedhistory", { target: reviewed });
    }
    const text = last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    const read = JSON.parse(text) as HistoryRead;
    historyReads.push(read);
    if (last.callId === "reviewedhistory") {
        const delegator = /^\d+\. AGENT \(([a-z0-9]+)\)$/mu.exec(read.history)?.[1];
        if (delegator === undefined) return verdict("deny");
        return readHistory("delegatorhistory", { target: delegator, roles: ["user"] });
    }
    return verdict(
        /^\d+\. USER\nText: .*push HEAD to main/mu.test(read.history) ? "allow" : "deny",
    );
}

function readHistory(callId: string, args: Record<string, unknown>): GymTurn {
    return {
        content: [{ type: "tool_call", name: "read_agent_history", callId, arguments: args }],
    };
}

function verdict(outcome: "allow" | "deny"): GymTurn {
    return {
        content: [
            {
                type: "text",
                text: `<review><outcome>${outcome}</outcome><risk_level>high</risk_level><user_authorization>${outcome === "allow" ? "high" : "unknown"}</user_authorization><rationale>Scripted review.</rationale></review>`,
            },
        ],
    };
}
