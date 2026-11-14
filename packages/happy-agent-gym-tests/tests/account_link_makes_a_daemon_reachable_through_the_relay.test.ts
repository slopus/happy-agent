import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Accounts and the relay are stand-ins written from their contract and protocol; the daemon, its
// admin bot, its tools, and the API a forwarded request reaches are the product.
import { FakeAccounts } from "../../happy-agent-modules/tests/accountLink/support/fakeAccounts.js";
import { FakeRelay } from "../../happy-agent-modules/tests/accountLink/support/fakeRelay.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";

const running = new Set<AgentGym>();
let accounts: FakeAccounts;
let relay: FakeRelay;

beforeEach(async () => {
    relay = await FakeRelay.start();
    accounts = await FakeAccounts.start(relay.url);
});

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    await relay.close();
    await accounts.close();
});

const call = (name: string, input: Record<string, unknown> = {}) => [
    { content: [{ type: "tool_call" as const, name, arguments: input }] },
    { content: [{ type: "text" as const, text: "Done." }] },
];

describe("a daemon linked to a Happy account", () => {
    it("is reached through the relay only by its owner, across a restart, until it is unlinked", async () => {
        const gym = await createAgentGym({
            config: [
                "[feature.account_link]",
                "enabled = true",
                `accounts_url = "${accounts.url}"`,
                `relay_url = "${relay.url}"`,
                "",
            ].join("\n"),
            inference: [
                ...call("link_happy_account"),
                ...call("get_happy_account_status"),
                ...call("set_happy_account_reachable", { reachable: true }),
                ...call("unlink_happy_account"),
            ],
            permissionMode: "full_access",
            timeoutMs: 20_000,
        });
        running.add(gym);
        const chief = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!;
        const asChief = { permissionMode: "full_access" as const, sessionId: chief.agent.id };
        const lastResult = (): string => JSON.stringify(gym.inference.toolResults().at(-1));

        await gym.send("Link this computer to my Happy account.", asChief);
        const userCode = accounts.pendingUserCodes[0]!;
        expect(lastResult()).toContain(userCode);
        expect(lastResult()).toContain(`${accounts.url}/device?user_code=${userCode}`);
        expect(relay.attachments).toEqual([]);

        accounts.approve(userCode, OWNER);
        await gym.waitUntil(
            () => (accounts.endpoints.length === 1 ? true : undefined),
            "accounts to issue the endpoint",
        );
        const endpoint = accounts.endpoints[0]!;
        await gym.send("Is it linked?", asChief);
        expect(lastResult()).toContain(`linked to Happy account ${OWNER}`);
        expect(lastResult()).toContain("not reachable");
        expect(relay.attachments).toEqual([]);

        await gym.send("Make it reachable.", asChief);
        await relay.waitForAttach();
        expect(endpoint.reachable).toBe(true);
        const owner = async (): Promise<[string, string][]> => [
            ["authorization", `Bearer ${await accounts.relayToken(endpoint.id)}`],
        ];

        const direct = await gym.http.get("/v0/health");
        const relayed = await relay.request({ headers: await owner(), path: "/v0/health" }).done;
        expect(relayed.status).toBe(200);
        expect(JSON.parse(relayed.body.toString("utf8"))).toEqual(JSON.parse(direct.text));

        const refused = async (headers: [string, string][]): Promise<number> =>
            (await relay.request({ headers, path: "/v0/health" }).done).status;
        await expect(refused([])).resolves.toBe(401);
        await expect(refused([["authorization", `Bearer ${gym.token}`]])).resolves.toBe(401);
        await expect(
            refused([
                [
                    "authorization",
                    `Bearer ${await accounts.relayToken(endpoint.id, { expiresInSeconds: -5 })}`,
                ],
            ]),
        ).resolves.toBe(401);
        await expect(
            refused([
                [
                    "authorization",
                    `Bearer ${await accounts.relayToken(endpoint.id, { claims: { sub: STRANGER } })}`,
                ],
            ]),
        ).resolves.toBe(403);

        // The daemon's own event stream, as a phone would hold it open through the relay.
        const events = relay.request({ headers: await owner(), path: "/v0/events/stream" });
        expect(await events.head).toMatchObject({ status: 200 });
        await gym.waitUntil(
            () => (events.received().toString("utf8").includes("hello") ? true : undefined),
            "the event stream's first frame through the relay",
        );
        events.abort();

        await gym.restart();
        await relay.waitForAttach(2);
        const afterRestart = await relay.request({ headers: await owner(), path: "/v0/health" })
            .done;
        expect(afterRestart.status).toBe(200);

        await gym.send("Unlink this computer.", asChief);
        await relay.waitForDetach();
        expect(endpoint).toMatchObject({ reachable: false, revoked: true });
        expect(lastResult()).toContain("not linked to a Happy account");
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 120_000);

    it("offers the tools to nobody when the feature is not configured", async () => {
        const gym = await createAgentGym({
            inference: call("link_happy_account"),
            permissionMode: "full_access",
        });
        running.add(gym);
        const chief = (await gym.client.listBots()).bots.find(
            (bot) => bot.isAdmin && bot.status === "active",
        )!;

        await gym.send("Link this computer.", {
            permissionMode: "full_access",
            sessionId: chief.agent.id,
        });

        expect(JSON.stringify(gym.inference.toolResults().at(-1))).not.toContain(
            "Waiting for approval",
        );
        expect(accounts.requests).toEqual([]);
    });
});
