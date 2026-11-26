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

const QUESTION = "Did the person ask for HEAD to be pushed to main?";

/**
 * A child agent's reviewer that cannot find authorization asks its parent before it denies. The
 * question goes to a temporary fork of the parent's reviewer, built from the parent's own evidence,
 * which answers and is discarded; a fork whose agent also has a parent may ask further up, to the
 * root. The scripted reviewers do what the policy asks: ask first, then allow only when the answer
 * reports the person's own request.
 */
describe("Auto review asks the parent's reviewer before denying", () => {
    it.each([
        ["allows", "Please push HEAD to main.", "allow"],
        ["denies", "Please tidy the docs.", "deny"],
    ] as const)(
        "%s a child's push when the parent's person said %j",
        async (_name, parentUserText, expected) => {
            const seen = new Seen();
            const gym = await createAgentGym({
                permissionMode: "auto",
                inference: (request) =>
                    answer(request, seen, (messages) =>
                        request.sessionId === gym.defaultSessionId
                            ? delegate("delegatepush", "Push HEAD to main.")
                            : messages.includes("Message from agent")
                              ? push()
                              : undefined,
                    ),
            });
            running.add(gym);
            const parentId = gym.defaultSessionId;

            await gym.send(parentUserText);
            const pushed = await gym.waitUntil(
                () => gym.inference.toolResults().find((result) => result.callId === "childpush"),
                "the child's push to be reviewed",
                30_000,
            );

            // The child's reviewer was offered the question, told to ask it before reading any
            // history, and asked it once.
            const childReview = seen.reviews.find((request) => hasTool(request, "ask_parent"));
            expect(childReview).toBeDefined();
            const { instructions } = childReview!;
            expect(instructions).toContain("you have the `ask_parent` tool");
            expect(instructions).toContain("use `read_agent_history`");
            expect(instructions.indexOf("call `ask_parent` first")).toBeGreaterThan(0);
            expect(instructions.indexOf("call `ask_parent` first")).toBeLessThan(
                instructions.indexOf("use `read_agent_history`"),
            );
            expect(seen.forks).toHaveLength(1);
            const fork = seen.forks[0]!;
            const forkPrompt = firstText(fork);
            // The fork is the parent's reviewer: the parent's evidence, the parent named as the
            // reviewed agent, the child as the one asking, and no proposed action.
            expect(forkPrompt).toContain(`<reviewed_agent_id>${parentId}</reviewed_agent_id>`);
            expect(forkPrompt).toContain(`User:\n${parentUserText}`);
            expect(forkPrompt).toContain(`<question>\n${QUESTION}\n</question>`);
            expect(forkPrompt).not.toContain("<proposed_action>");
            expect(fork.sessionId).not.toBe(parentId);
            expect(fork.sessionId).not.toBe(childReview!.sessionId);
            // The parent is the root: its fork can ask no one.
            expect(hasTool(fork, "ask_parent")).toBe(false);
            if (expected === "allow") {
                expect(pushed.text).toContain("pushed-to-main");
            } else {
                expect(pushed.text).toContain("Automatic permission review refused");
            }

            // The fork left nothing behind in the parent: no event, and no inference of its own.
            const parentEvents = JSON.stringify(await gym.sessionEvents(parentId));
            expect(parentEvents).not.toContain(QUESTION);
            expect(parentEvents).not.toContain("<subagent_id>");
            expect(
                gym.inference.requests
                    .filter((request) => request.sessionId === parentId)
                    .some((request) => JSON.stringify(request.messages).includes(QUESTION)),
            ).toBe(false);
            expect(gym.errors).toEqual([]);
        },
        60_000,
    );

    it("asks up a chain of parents until the root's reviewer answers", async () => {
        const seen = new Seen();
        const gym = await createAgentGym({
            permissionMode: "auto",
            inference: (request) =>
                answer(request, seen, (messages) =>
                    request.sessionId === gym.defaultSessionId
                        ? delegate("delegatemiddle", "Delegate the push.")
                        : messages.includes("Delegate the push.")
                          ? delegate("delegateleaf", "Push HEAD to main.")
                          : messages.includes("Message from agent")
                            ? push()
                            : undefined,
                ),
        });
        running.add(gym);
        const rootId = gym.defaultSessionId;

        await gym.send("Please push HEAD to main.");
        const pushed = await gym.waitUntil(
            () => gym.inference.toolResults().find((result) => result.callId === "childpush"),
            "the grandchild's push to be reviewed",
            30_000,
        );

        expect(pushed.text).toContain("pushed-to-main");
        // The middle agent's fork could not see the person, so it asked the root's, then relayed
        // the root's answer: two forks, three inferences.
        expect(new Set(seen.forks.map((request) => request.sessionId)).size).toBe(2);
        const [middleFork, rootFork, middleRelay] = seen.forks;
        expect(middleRelay!.sessionId).toBe(middleFork!.sessionId);
        expect(hasTool(middleFork!, "ask_parent")).toBe(true);
        expect(firstText(middleFork!)).not.toContain("User:\nPlease push HEAD to main.");
        expect(firstText(rootFork!)).toContain(`<reviewed_agent_id>${rootId}</reviewed_agent_id>`);
        expect(firstText(rootFork!)).toContain("User:\nPlease push HEAD to main.");
        expect(firstText(rootFork!)).toContain(
            `<subagent_id>${reviewedAgentId(middleFork!)}</subagent_id>`,
        );
        expect(hasTool(rootFork!, "ask_parent")).toBe(false);
        expect(seen.answers).toEqual([
            'Yes. The user wrote: "Please push HEAD to main."',
            'My parent\'s reviewer answered: Yes. The user wrote: "Please push HEAD to main."',
        ]);
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("stops the whole chain when the reviewed turn is stopped", async () => {
        const seen = new Seen();
        let leafId = "";
        let stopped = false;
        const gym = await createAgentGym({
            permissionMode: "auto",
            inference: (request) => {
                if (isFork(request) && hasTool(request, "ask_parent") === false) {
                    // The root's fork, two questions up, is inferring when the leaf is stopped.
                    seen.forks.push(request);
                    return {
                        events: [{ type: "text_start" }],
                        hold: {
                            afterEvents: 0,
                            onHeld: () => {
                                stopped = true;
                                void gym.abort(leafId);
                            },
                        },
                    };
                }
                return answer(request, seen, (messages) => {
                    if (request.sessionId === gym.defaultSessionId)
                        return delegate("delegatemiddle", "Delegate the push.");
                    if (messages.includes("Delegate the push."))
                        return delegate("delegateleaf", "Push HEAD to main.");
                    if (messages.includes("Message from agent")) {
                        leafId = request.sessionId;
                        return push();
                    }
                    return undefined;
                });
            },
        });
        running.add(gym);

        await gym.send("Please push HEAD to main.");
        await gym.waitUntil(() => stopped || undefined, "the root's fork to be asked", 30_000);
        const requestsAtStop = gym.inference.requests.length;

        // The leaf's run settles well inside the question's own deadline: stopping it stopped its
        // reviewer, whose question stopped the middle fork, whose question stopped the root's.
        await gym.waitUntil(
            async () =>
                (await gym.sessionEvents(leafId)).find((event) => event.type === "run.finished"),
            "the stopped leaf's run to settle",
            20_000,
        );
        expect(gym.inference.toolResults().some((result) => result.callId === "childpush")).toBe(
            false,
        );
        // Nothing in the chain inferred again: no fork relayed an answer and no reviewer decided.
        const after = gym.inference.requests.slice(requestsAtStop);
        expect(after.filter((request) => request.instructions.includes("<outcome>"))).toEqual([]);
        expect(seen.answers).toEqual([]);
    }, 60_000);
});

/** What the scripted reviewers and forks were asked, in order. */
class Seen {
    readonly reviews: GymInferenceRequest[] = [];
    readonly forks: GymInferenceRequest[] = [];
    /** Each answer an `ask_parent` call returned, in the order the askers read them. */
    readonly answers: string[] = [];
}

/**
 * The scripted model: titles, reviewers, forked parent reviewers, and the main agents, whose
 * delegation `main` scripts.
 */
function answer(
    request: GymInferenceRequest,
    seen: Seen,
    main: (messages: string) => GymTurn | undefined,
): GymTurn {
    if (
        request.sessionId.startsWith("naming:") ||
        request.instructions.includes("You name a piece of work")
    ) {
        return text("<title>Push</title><slug>push</slug>");
    }
    if (isFork(request)) {
        seen.forks.push(request);
        return forkAnswer(request, seen);
    }
    if (request.instructions.includes("<outcome>")) {
        seen.reviews.push(request);
        return review(request, seen);
    }
    if (request.messages.at(-1)?.role === "tool") return text("Done.");
    return main(JSON.stringify(request.messages)) ?? text("UNEXPECTED_AGENT");
}

/**
 * The policy, scripted for the reviewer of an agent that has a parent: a push is asked about
 * first, and allowed only when the answer reports the person's own request.
 */
function review(request: GymInferenceRequest, seen: Seen): GymTurn {
    const prompt = firstText(request);
    const proposed = prompt.slice(prompt.lastIndexOf("<proposed_action>"));
    if (!proposed.includes("exec_command")) return verdict("allow");
    const last = request.messages.at(-1);
    if (last?.role !== "tool") {
        return hasTool(request, "ask_parent") ? askParent() : verdict("deny");
    }
    const reply = toolText(last);
    seen.answers.push(reply);
    return verdict(reply.startsWith("unknown") ? "deny" : "allow");
}

/**
 * A forked parent reviewer: it answers from the person's own messages in its conversation, asks
 * its own parent when it can and they are not there, and otherwise says "unknown".
 */
function forkAnswer(request: GymInferenceRequest, seen: Seen): GymTurn {
    const prompt = firstText(request);
    const conversation = prompt.slice(0, prompt.indexOf("</conversation>"));
    const quoted = /\[\d+\] User:\n([^\n]*push HEAD to main[^\n]*)/iu.exec(conversation)?.[1];
    if (quoted !== undefined) return text(`Yes. The user wrote: "${quoted}"`);
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
        const reply = toolText(last);
        seen.answers.push(reply);
        return text(`My parent's reviewer answered: ${reply}`);
    }
    return hasTool(request, "ask_parent") ? askParent() : text("unknown");
}

function isFork(request: GymInferenceRequest): boolean {
    return (
        request.instructions.includes("<outcome>") && firstText(request).includes("<subagent_id>")
    );
}

function reviewedAgentId(request: GymInferenceRequest): string | undefined {
    return /<reviewed_agent_id>([a-z0-9]+)<\/reviewed_agent_id>/u.exec(firstText(request))?.[1];
}

function hasTool(request: GymInferenceRequest, name: string): boolean {
    return request.tools.some((tool) => tool.name === name);
}

function firstText(request: GymInferenceRequest): string {
    const first = request.messages[0];
    return first?.role === "user"
        ? first.content.map((block) => (block.type === "text" ? block.text : "")).join("")
        : "";
}

function toolText(message: NonNullable<GymInferenceRequest["messages"][number]>): string {
    return message.role === "tool"
        ? message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
        : "";
}

function delegate(callId: string, task: string): GymTurn {
    return {
        content: [
            {
                type: "tool_call",
                name: "create_agent",
                callId,
                arguments: {
                    provider: "gym",
                    model: "gym/model",
                    effort: "medium",
                    title: "Push",
                    text: task,
                },
            },
        ],
    };
}

function push(): GymTurn {
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

function askParent(): GymTurn {
    return {
        content: [
            {
                type: "tool_call",
                name: "ask_parent",
                callId: "askparent",
                arguments: { question: QUESTION },
            },
        ],
    };
}

function text(value: string): GymTurn {
    return { content: [{ type: "text", text: value }] };
}

function verdict(outcome: "allow" | "deny"): GymTurn {
    return text(
        `<review><outcome>${outcome}</outcome><risk_level>high</risk_level><user_authorization>${outcome === "allow" ? "high" : "unknown"}</user_authorization><rationale>Scripted review.</rationale></review>`,
    );
}
