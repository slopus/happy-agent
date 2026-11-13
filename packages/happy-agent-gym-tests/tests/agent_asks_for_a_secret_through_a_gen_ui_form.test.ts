import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const STRIPE_KEY = "sk_test_51NzQvalueTheAgentMustNeverSee";
const WEBHOOK_SECRET = "whsec_0valueTheAgentMustNeverSeeEither";

function said(request: GymInferenceRequest, text: string): boolean {
    return JSON.stringify(request.messages).includes(text);
}

/** A gym whose model asks for Stripe keys, then acknowledges whatever notice it is given. */
async function stripeGym(): Promise<AgentGym> {
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        inference: (request) => {
            const last = JSON.stringify(request.messages.at(-1));
            if (last.includes("I want to add Stripe")) {
                return {
                    content: [
                        {
                            type: "tool_call",
                            callId: "ask_for_stripe",
                            name: "request_secret",
                            arguments: {
                                title: "Stripe test keys",
                                explanation:
                                    "I need your Stripe **test-mode** keys to run the billing tests.",
                                id: "stripe",
                                description: "Stripe test-mode keys for the billing service",
                                variables: [
                                    {
                                        name: "STRIPE_SECRET_KEY",
                                        description: "Secret key, starts with sk_test_",
                                    },
                                    { name: "STRIPE_WEBHOOK_SECRET" },
                                ],
                            },
                        },
                    ],
                };
            }
            if (last.includes("ask_for_stripe")) {
                return { content: [{ type: "text", text: "Add the keys in the card above." }] };
            }
            return { content: [{ type: "text", text: "Thanks, noted." }] };
        },
    });
    running.add(gym);
    return gym;
}

describe("an agent asks for a secret through a Gen UI form", () => {
    it("gets the secret the person saved, then changed, and never a value", async () => {
        const gym = await stripeGym();
        const agentId = gym.defaultSessionId;
        const { capabilities } = await gym.client.getHealth();
        expect(capabilities?.artifactSecretActions).toBe(true);
        expect(capabilities?.plugins).toBeUndefined();
        await gym.send("I want to add Stripe to the billing service.");

        const { artifacts } = await gym.http.ok<{
            artifacts: { id: string; type: string; latestVersion: number }[];
        }>("GET", `/v0/artifacts?agentId=${agentId}`);
        expect(artifacts.map((artifact) => artifact.type)).toEqual(["gen_ui"]);
        const card = artifacts[0]!;
        const base = `/v0/artifacts/${card.id}/versions/${String(card.latestVersion)}`;
        const page = await gym.client.getMessages(agentId);
        const call = page.runs
            .flatMap((run) => run.messages)
            .flatMap((message) => message.content)
            .find((block) => block.type === "tool_call" && block.name === "request_secret");
        expect(call).toMatchObject({
            status: "completed",
            presentation: {
                type: "artifact",
                artifactId: card.id,
                version: card.latestVersion,
                artifactType: "gen_ui",
                title: "Stripe test keys",
                shows: "latest",
            },
        });
        const render = await gym.http.ok<{
            elements: Record<string, { type: string; props: Record<string, unknown> }>;
        }>("GET", `${base}/files/.genui/render.json`);
        expect(render.elements["secret"]).toEqual({
            type: "button",
            props: {
                label: "Add secret",
                icon: "lock",
                variant: "primary",
                action: {
                    type: "secret",
                    secret: {
                        id: "stripe",
                        description: "Stripe test-mode keys for the billing service",
                        variables: [
                            {
                                name: "STRIPE_SECRET_KEY",
                                description: "Secret key, starts with sk_test_",
                            },
                            { name: "STRIPE_WEBHOOK_SECRET" },
                        ],
                    },
                },
            },
        });

        const notActions = await Promise.all([
            gym.http.post(`${base}/actions`, {
                id: "save0wrongelement00000000",
                element: "nothere",
                secret: { id: "stripe", description: "x", environment: { A: "1" } },
            }),
            gym.http.post(`${base}/actions`, {
                id: "save0notasecret000000000",
                element: "card",
                secret: { id: "stripe", description: "x", environment: { A: "1" } },
            }),
        ]);
        expect(notActions.map((response) => response.status)).toEqual([404, 400]);

        // The person renames the secret and fills in only the key.
        const create = {
            id: "save1stripecreate00000000",
            element: "secret",
            secret: {
                id: "stripe-test",
                description: "Stripe test keys",
                environment: { STRIPE_SECRET_KEY: STRIPE_KEY },
            },
        };
        const created = await gym.client.saveArtifactSecretAction(
            card.id,
            card.latestVersion,
            create,
        );
        expect(created.outcome).toBe("created");
        expect(created.secret).toMatchObject({
            id: "stripe-test",
            description: "Stripe test keys",
            environmentVariables: ["STRIPE_SECRET_KEY"],
            availableToAgents: true,
        });
        const notice = await gym.waitUntil(
            () =>
                gym.inference.requests.find((request) =>
                    said(request, 'The user added the secret \\"stripe-test\\"'),
                ),
            "the agent to be told the secret was added",
        );
        expect(said(notice, "It holds STRIPE_SECRET_KEY.")).toBe(true);
        expect(said(notice, "It does not hold STRIPE_WEBHOOK_SECRET, which you asked for.")).toBe(
            true,
        );

        const retried = await gym.client.saveArtifactSecretAction(
            card.id,
            card.latestVersion,
            create,
        );
        expect(retried).toEqual(created);
        const { attachments } = await gym.http.ok<{
            attachments: { target: { type: string; id: string } }[];
        }>("GET", "/v0/secrets/stripe-test/attachments");
        expect(attachments.map((attachment) => attachment.target)).toEqual([
            { type: "agent", id: agentId },
        ]);

        const overwrite = await gym.http.post(`${base}/actions`, {
            ...create,
            id: "save2overwrite00000000000",
        });
        expect(overwrite.status).toBe(409);

        // Tapping the button again changes the secret: the webhook secret is added, the key kept.
        const changed = await gym.client.saveArtifactSecretAction(card.id, card.latestVersion, {
            id: "save3stripechange00000000",
            element: "secret",
            secret: {
                id: "stripe-test",
                description: "Stripe test keys",
                environment: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET },
            },
            ifMatch: created.secret.version,
        });
        expect(changed.outcome).toBe("updated");
        expect(changed.secret).toMatchObject({
            environmentVariables: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
        });
        await gym.waitUntil(
            () =>
                gym.inference.requests.find((request) =>
                    said(
                        request,
                        'The user changed the secret \\"stripe-test\\" from \\"Stripe test keys\\". It holds STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET. It is attached to you',
                    ),
                ),
            "the agent to be told the secret changed",
        );
        const stale = await gym.http.post(`${base}/actions`, {
            id: "save4stale000000000000000",
            element: "secret",
            secret: {
                id: "stripe-test",
                description: "Stripe test keys",
                environment: { STRIPE_SECRET_KEY: "sk_test_stale" },
            },
            ifMatch: created.secret.version,
        });
        expect(stale.status).toBe(409);
        await gym.waitForEvent(
            (event) =>
                event.type === "run.finished" &&
                JSON.stringify(event).includes(agentId) &&
                gym.inference.requests.filter((request) => said(request, "the secret")).length >= 2,
            "the agent's run on the second notice to settle",
        );

        const everything = JSON.stringify([
            gym.inference.requests,
            await gym.events(),
            await gym.sessionEvents(),
        ]);
        expect(everything).not.toContain(STRIPE_KEY);
        expect(everything).not.toContain(WEBHOOK_SECRET);
        expect(everything).not.toContain("sk_test_stale");
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("refuses a form from a card a person published, which no agent asked for", async () => {
        const gym = await stripeGym();
        const card = {
            genui: 1,
            fallback: "Add a Stripe key.",
            root: {
                type: "card",
                title: "Stripe",
                children: [{ type: "text", text: "Add a key." }],
                actions: [
                    {
                        type: "button",
                        id: "secret",
                        label: "Add secret",
                        action: {
                            type: "secret",
                            secret: { id: "stripe", variables: [{ name: "STRIPE_SECRET_KEY" }] },
                        },
                    },
                ],
            },
        };
        const { artifact } = await gym.http.ok<{ artifact: { id: string } }>(
            "POST",
            "/v0/artifacts",
            {
                type: "gen_ui",
                title: "Stripe",
                files: [{ path: "index.genui.json", text: JSON.stringify(card) }],
            },
        );
        const refused = await gym.http.post(`/v0/artifacts/${artifact.id}/versions/1/actions`, {
            id: "save1personcard000000000",
            element: "secret",
            secret: {
                id: "stripe",
                description: "Stripe keys",
                environment: { STRIPE_SECRET_KEY: STRIPE_KEY },
            },
        });
        expect(refused.status).toBe(409);
        expect(refused.text).not.toContain(STRIPE_KEY);
        expect((await gym.http.get("/v0/secrets/stripe")).status).toBe(404);
    });
});
