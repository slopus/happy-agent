import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("secret tools keep complete metadata on large pages", () => {
    it("retains descriptions, variable names and pagination without exposing values", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            type: "tool_call",
                            name: "list_secrets",
                            callId: "first_page",
                            arguments: { limit: 8 },
                        },
                    ],
                },
                {
                    content: [
                        {
                            type: "tool_call",
                            name: "list_secrets",
                            callId: "last_page",
                            arguments: { limit: 8, cursor: "metadata-7" },
                        },
                        {
                            type: "tool_call",
                            name: "reference_secret",
                            callId: "large_reference",
                            arguments: { id: "metadata-0" },
                        },
                    ],
                },
                { content: [{ type: "text", text: "Catalog read." }] },
            ],
        });
        running.add(gym);

        const fixtures = Array.from({ length: 9 }, (_, index) => ({
            id: `metadata-${index}`,
            description: `Credential ${index}: ${"description ".repeat(180)}`.slice(0, 2_000),
            environment: Object.fromEntries(
                Array.from({ length: index === 0 ? 100 : 1 }, (_, variable) => [
                    `TOKEN_${index}_${variable}_${"X".repeat(120)}`,
                    `private-fixture-value-${index}-${variable}`,
                ]),
            ),
            availableToAgents: index !== 8,
        }));
        for (const fixture of fixtures) await gym.client.createSecret(fixture);

        await gym.send("List the secret catalog, continue its page, and read metadata-0.");

        const results = gym.inference.toolResults();
        const serializedResults = JSON.stringify(results);
        const serializedEvents = JSON.stringify(await gym.sessionEvents());
        const first = JSON.stringify(results.find((result) => result.callId === "first_page"));
        const last = JSON.stringify(results.find((result) => result.callId === "last_page"));
        const reference = JSON.stringify(
            results.find((result) => result.callId === "large_reference"),
        );
        expect(first.length).toBeGreaterThan(12_000);
        expect(first).toContain('next=\\"metadata-7\\"');
        expect(first).not.toContain("metadata-8");
        expect(last).not.toContain("next=");
        expect(last).toContain("Availability: not available to agents");
        expect(reference.length).toBeGreaterThan(12_000);
        for (const [index, fixture] of fixtures.entries()) {
            const output = index < 8 ? first : last;
            expect(output).toContain(fixture.id);
            expect(output).toContain(fixture.description);
            for (const name of Object.keys(fixture.environment)) {
                expect(output).toContain(name);
                if (index === 0) expect(reference).toContain(name);
            }
            if (index === 0) expect(reference).toContain(fixture.description);
            for (const value of Object.values(fixture.environment)) {
                expect(serializedResults).not.toContain(value);
                expect(serializedEvents).not.toContain(value);
            }
        }
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    }, 60_000);
});
