import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RelayConnector } from "../../sources/accountLink/impl/RelayConnector.js";
import { FakeRelay } from "./support/fakeRelay.js";

let relay: FakeRelay;
const connectors: RelayConnector[] = [];
const tokens: boolean[] = [];

beforeEach(async () => {
    relay = await FakeRelay.start();
    tokens.length = 0;
});

afterEach(async () => {
    await Promise.all(connectors.splice(0).map((connector) => connector.close()));
    await relay.close();
});

function connect(
    timing: ConstructorParameters<typeof RelayConnector>[1]["timing"],
): RelayConnector {
    const connector = new RelayConnector(createRootContext().named("relay-connector-test"), {
        attachUrl: `${relay.url.replace("http", "ws")}/e/endpoint-1/attach`,
        authorize: async () => ({ allowed: false, refusal: "unauthenticated" }),
        beforeAttach: async () => undefined,
        endpointToken: async (fresh) => {
            tokens.push(fresh);
            return "endpoint-token";
        },
        localApi: { socketPath: "/nonexistent", tokenPath: "/nonexistent" },
        onAttached: () => undefined,
        timing: { backoffFirstMs: 20, backoffMaxMs: 80, ...timing },
    });
    connectors.push(connector);
    return connector;
}

describe("RelayConnector", () => {
    it("waits at least thirty seconds by default after being replaced, and pings every thirty", () => {
        // The defaults are the protocol's numbers; the tests below shorten them through `timing`.
        expect(RelayConnector.defaultTiming).toMatchObject({
            pingIntervalMs: 30_000,
            pongTimeoutMs: 10_000,
            replacedBackoffMs: 30_000,
        });
    });

    it("does not reattach at once when another computer replaced it", async () => {
        const connector = connect({ replacedBackoffMs: 800 });
        await relay.waitForAttach();

        relay.replace();
        await relay.waitForDetach();
        await new Promise((resolve) => setTimeout(resolve, 600));

        expect(relay.attachments).toHaveLength(1);
        expect(connector.error).toBe(
            "Another Happy Agent attached to the Happy Relay as this computer. Only one can be reachable at a time.",
        );
        await relay.waitForAttach(2, 2_000);
    });

    it("reattaches quickly after an ordinary drop, backing off while the relay is down", async () => {
        const connector = connect({ replacedBackoffMs: 60_000 });
        await relay.waitForAttach();

        relay.drop();
        await relay.waitForAttach(2, 1_000);
        expect(connector.state).toBe("attached");
        expect(connector.error).toBeUndefined();
    });

    it("asks for a fresh token after the relay answers 401 and keeps retrying", async () => {
        relay.refuseAttachWith = 401;
        const connector = connect({});

        await expect.poll(() => relay.attachments.length).toBeGreaterThanOrEqual(3);
        expect(tokens.slice(0, 3)).toEqual([false, true, true]);
        expect(connector.state).toBe("connecting");
        expect(connector.error).toBe("The Happy Relay refused this computer (HTTP 401).");

        relay.refuseAttachWith = undefined;
        await relay.waitForAttach();
        expect(connector.error).toBeUndefined();
    });

    it("sends protocol pings and replaces a socket whose pongs stop", async () => {
        connect({ pingIntervalMs: 40, pongTimeoutMs: 120 });
        const first = await relay.waitForAttach();
        await expect.poll(() => first.pings).toBeGreaterThanOrEqual(3);
        expect(relay.attachments).toHaveLength(1);

        relay.answerPings = false;

        await relay.waitForAttach(2, 2_000);
        expect(first.socket.readyState).toBe(3);
    });

    it("leaves a relay that speaks another protocol version and serves nothing", async () => {
        relay.version = 2;
        connect({});

        await expect.poll(() => relay.closes.length).toBeGreaterThanOrEqual(1);
        expect(relay.closes[0]).toEqual({ code: 1002 });
    });

    it("stops for good when closed", async () => {
        const connector = connect({});
        await relay.waitForAttach();

        await connector.close();
        await relay.waitForDetach();
        await new Promise((resolve) => setTimeout(resolve, 300));

        expect(relay.attachments).toHaveLength(1);
    });
});
