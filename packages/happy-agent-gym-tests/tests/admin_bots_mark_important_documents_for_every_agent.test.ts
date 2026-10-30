import {
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const REVIEWER_CONTRACT = "end your final message with your verdict inside a <review> block";

/**
 * A gym where each agent runs exactly the tool call it is asked for, and the Auto reviewer allows
 * or refuses as the scenario says, recording what it saw.
 */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const reviews: string[] = [];
    let allow = true;
    const gym = await createAgentGym({
        permissionMode: "auto",
        timeoutMs: 20_000,
        inference: (request: GymInferenceRequest): GymTurn => {
            if (request.instructions.includes(REVIEWER_CONTRACT)) {
                reviews.push(JSON.stringify(request.messages));
                const outcome = allow ? "allow" : "deny";
                return {
                    content: [
                        {
                            type: "text",
                            text: `<review><outcome>${outcome}</outcome><risk_level>low</risk_level><user_authorization>high</user_authorization><rationale>Scripted.</rationale></review>`,
                        },
                    ],
                };
            }
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Settled." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function call(agentId: string, name: string, args: Record<string, unknown>) {
        const callId = `important_documents_call_${++callIndex}`;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please run ${name}, request ${callId}.`, { sessionId: agentId });
        return await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            `the ${name} result`,
        );
    }
    /** The instructions an ordinary agent's next inference is given. */
    async function instructionsOfNextTurn(agentId: string): Promise<string> {
        const before = gym.inference.requests.length;
        await gym.send("What should I know?", { sessionId: agentId });
        const request = await gym.waitUntil(
            async () =>
                gym.inference.requests
                    .slice(before)
                    .find(
                        (candidate) =>
                            candidate.sessionId === agentId &&
                            !candidate.instructions.includes(REVIEWER_CONTRACT),
                    ),
            "the agent's next inference",
        );
        return request.instructions;
    }
    return {
        gym,
        call,
        instructionsOfNextTurn,
        reviews,
        setReviews: (outcome: "allow" | "deny") => {
            allow = outcome === "allow";
        },
    };
}

describe("admin bots mark important documents for every agent", () => {
    it("lists a marked document in every agent's instructions until it is unmarked", async () => {
        const { gym, call, instructionsOfNextTurn, reviews, setReviews } = await harness();
        const document = (
            await gym.client.createSurface({ type: "document", name: "Release process" })
        ).surface;
        const admin = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!;
        expect(document.promptDocument).toBeNull();
        const listed = async () =>
            (await gym.client.listSurfaces()).surfaces.find(
                (surface) => surface.id === document.id,
            );
        expect(await instructionsOfNextTurn(gym.defaultSessionId)).not.toContain(
            "# Important documents",
        );

        const marked = await call(admin.agent.id, "mark_prompt_document", {
            surfaceId: document.id,
            description: "How to cut a release. Read it before releasing anything.",
        });
        expect(marked.text).toContain(`Marked ${document.id} as an important document.`);
        expect(reviews).toHaveLength(1);
        expect((await listed())?.promptDocument).toEqual({
            description: "How to cut a release. Read it before releasing anything.",
        });
        expect(
            (await gym.client.getDesktopBootstrap()).surfaces?.find(
                (surface) => surface.id === document.id,
            )?.promptDocument,
        ).toEqual({
            description: "How to cut a release. Read it before releasing anything.",
        });

        const instructions = await instructionsOfNextTurn(gym.defaultSessionId);
        expect(instructions).toContain("# Important documents");
        expect(instructions).toContain("with read_document");
        expect(instructions).toContain(
            [
                "  <document>",
                "    <name>Release process</name>",
                "    <description>How to cut a release. Read it before releasing anything.</description>",
                `    <surface_id>${document.id}</surface_id>`,
                `    <link>happy://surfaces/${document.id}</link>`,
                "  </document>",
            ].join("\n"),
        );

        // The list follows the document's live name.
        await gym.client.updateSurface(document.id, { name: "Shipping a release" });
        expect(await instructionsOfNextTurn(gym.defaultSessionId)).toContain(
            "<name>Shipping a release</name>",
        );

        // A refused review leaves the list as it was.
        setReviews("deny");
        const refused = await call(admin.agent.id, "unmark_prompt_document", {
            surfaceId: document.id,
        });
        expect(refused.text).not.toContain("Unmarked");
        expect(await instructionsOfNextTurn(gym.defaultSessionId)).toContain(
            `<surface_id>${document.id}</surface_id>`,
        );

        setReviews("allow");
        const unmarked = await call(admin.agent.id, "unmark_prompt_document", {
            surfaceId: document.id,
        });
        expect(unmarked.text).toContain(`Unmarked ${document.id}.`);
        expect((await listed())?.promptDocument).toBeNull();
        expect(await instructionsOfNextTurn(gym.defaultSessionId)).not.toContain(
            "# Important documents",
        );
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("keeps the admin tools away from agents that are not active admin bots", async () => {
        const { gym, call } = await harness();
        const document = (await gym.client.createSurface({ type: "document", name: "Notes" }))
            .surface;
        const result = await call(gym.defaultSessionId, "mark_prompt_document", {
            surfaceId: document.id,
            description: "Notes.",
        });
        expect(result.text).not.toContain("Marked");
        expect(
            gym.inference.requests
                .filter((request) => request.sessionId === gym.defaultSessionId)
                .at(-1)
                ?.tools.map((tool) => tool.name),
        ).not.toContain("mark_prompt_document");
    }, 60_000);
});
