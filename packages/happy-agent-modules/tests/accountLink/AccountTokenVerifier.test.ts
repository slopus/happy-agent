import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountTokenVerifier } from "../../sources/accountLink/impl/AccountTokenVerifier.js";
import { FakeAccounts, type TokenOverrides } from "./support/fakeAccounts.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";

let accounts: FakeAccounts;
let verifier: AccountTokenVerifier;
let endpointId: string;
let otherEndpointId: string;

beforeEach(async () => {
    accounts = await FakeAccounts.start();
    verifier = new AccountTokenVerifier(accounts.url, accounts.relayUrl);
    endpointId = await linkEndpoint(OWNER);
    otherEndpointId = await linkEndpoint(STRANGER);
});

afterEach(async () => {
    await accounts.close();
});

describe("relay token verification", () => {
    it("accepts the owner's relay token for this endpoint and reports its expiry", async () => {
        const before = Date.now();
        const decision = await decide(await accounts.relayToken(endpointId));

        expect(decision.allowed).toBe(true);
        if (!decision.allowed) return;
        expect(decision.expiresAt).toBeGreaterThanOrEqual(before + 899_000);
        expect(decision.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    });

    it.each<[string, string | readonly string[] | undefined]>([
        ["no header", undefined],
        ["an empty header", ""],
        ["a bare token without the Bearer scheme", "abc.def.ghi"],
        ["Basic credentials", "Basic dXNlcjpwYXNz"],
        ["a Bearer value that is not a JWT", "Bearer local-daemon-token"],
        ["two Authorization headers", ["Bearer a.b.c", "Bearer a.b.c"]],
    ])("refuses %s as unauthenticated without fetching keys", async (_name, authorization) => {
        await expect(
            verifier.verifyRelayAuthorization(authorization, { accountId: OWNER, endpointId }),
        ).resolves.toEqual({ allowed: false, refusal: "unauthenticated" });
        expect(accounts.jwksRequests).toBe(0);
    });

    it.each<[string, TokenOverrides, "unauthenticated" | "forbidden"]>([
        ["an expired token", { expiresInSeconds: -1 }, "unauthenticated"],
        ["a token without exp", { claims: { exp: undefined } }, "unauthenticated"],
        ["a token signed by another key", { foreignKey: true }, "unauthenticated"],
        ["a token naming an unknown key", { header: { kid: "k2" } }, "unauthenticated"],
        ["a token naming no key", { header: { kid: null } }, "unauthenticated"],
        ["another issuer", { claims: { iss: "https://accounts.attacker.test" } }, "forbidden"],
        ["the issuer with a trailing slash", { claims: { iss: "ISSUER/" } }, "forbidden"],
        ["the endpoint token audience", { claims: { aud: "RELAY/" } }, "forbidden"],
        ["another endpoint's audience", { claims: { aud: "RELAY/e/OTHER" } }, "forbidden"],
        [
            "an audience list containing ours",
            { claims: { aud: ["RELAY/e/SELF", "x"] } },
            "forbidden",
        ],
        ["an audience with a trailing slash", { claims: { aud: "RELAY/e/SELF/" } }, "forbidden"],
        ["no typ", { claims: { typ: undefined } }, "forbidden"],
        ["typ endpoint", { claims: { typ: "endpoint" } }, "forbidden"],
        ["typ mcp", { claims: { typ: "mcp" } }, "forbidden"],
        ["typ Relay in another case", { claims: { typ: "Relay" } }, "forbidden"],
        ["another endpoint id", { claims: { eid: "OTHER" } }, "forbidden"],
        ["no endpoint id", { claims: { eid: undefined } }, "forbidden"],
        ["another account as subject", { claims: { sub: STRANGER } }, "forbidden"],
        ["a gateway actor claim", { claims: { act: { cid: "connection-1" } } }, "forbidden"],
        ["an empty actor claim", { claims: { act: null } }, "forbidden"],
    ])("refuses %s", async (_name, overrides, refusal) => {
        const token = await accounts.relayToken(endpointId, {
            ...overrides,
            claims: substitute(overrides.claims),
        });

        await expect(decide(token)).resolves.toEqual({ allowed: false, refusal });
    });

    it("refuses another account's genuine relay token for its own endpoint", async () => {
        const token = await accounts.relayToken(otherEndpointId);

        await expect(decide(token)).resolves.toEqual({ allowed: false, refusal: "forbidden" });
    });

    it("refuses this machine's own endpoint token presented as a relay token", async () => {
        const token = await accounts.sign({
            aud: `${accounts.relayUrl}/`,
            eid: endpointId,
            sub: OWNER,
            typ: "endpoint",
        });

        await expect(decide(token)).resolves.toEqual({ allowed: false, refusal: "forbidden" });
    });

    it("refuses algorithms other than EdDSA before looking up any key", async () => {
        const claims = {
            aud: `${accounts.relayUrl}/e/${endpointId}`,
            eid: endpointId,
            exp: Math.floor(Date.now() / 1_000) + 900,
            iss: accounts.url,
            sub: OWNER,
            typ: "relay",
        };
        const hmac = await new SignJWT(claims)
            .setProtectedHeader({ alg: "HS256", kid: "k1" })
            .sign(new TextEncoder().encode("a-shared-secret-of-sufficient-length"));
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const unsigned = `${encode({ alg: "none", kid: "k1" })}.${encode(claims)}.`;
        const noneWithSignature = `${encode({ alg: "none", kid: "k1" })}.${encode(claims)}.AAAA`;

        for (const token of [hmac, unsigned, noneWithSignature]) {
            await expect(decide(token)).resolves.toEqual({
                allowed: false,
                refusal: "unauthenticated",
            });
        }
        expect(accounts.jwksRequests).toBe(0);
    });

    it("refuses a token whose payload was altered after signing", async () => {
        const [header, payload, signature] = (await accounts.relayToken(otherEndpointId)).split(
            ".",
        );
        const claims = JSON.parse(
            Buffer.from(payload ?? "", "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        const forged = Buffer.from(
            JSON.stringify({
                ...claims,
                aud: `${accounts.relayUrl}/e/${endpointId}`,
                eid: endpointId,
                sub: OWNER,
            }),
        ).toString("base64url");

        await expect(decide(`${header ?? ""}.${forged}.${signature ?? ""}`)).resolves.toEqual({
            allowed: false,
            refusal: "unauthenticated",
        });
    });

    it("fails closed when the key set cannot be fetched", async () => {
        accounts.jwksStatus = 503;

        await expect(decide(await accounts.relayToken(endpointId))).resolves.toEqual({
            allowed: false,
            refusal: "unverifiable",
        });
    });

    it("caches the key set across requests", async () => {
        for (let index = 0; index < 5; index += 1) {
            expect((await decide(await accounts.relayToken(endpointId))).allowed).toBe(true);
        }
        expect(accounts.jwksRequests).toBe(1);
    });
});

describe("endpoint token verification", () => {
    it("reads the endpoint and owner from a genuine endpoint token", async () => {
        const token = await accounts.sign({
            aud: `${accounts.relayUrl}/`,
            eid: endpointId,
            sub: OWNER,
            typ: "endpoint",
        });

        await expect(verifier.verifyEndpointToken(token)).resolves.toMatchObject({
            accountId: OWNER,
            endpointId,
        });
    });

    it("rejects a relay token, a foreign signature, and a token without an endpoint id", async () => {
        await expect(
            verifier.verifyEndpointToken(await accounts.relayToken(endpointId)),
        ).rejects.toThrow();
        const claims = {
            aud: `${accounts.relayUrl}/`,
            eid: endpointId,
            sub: OWNER,
            typ: "endpoint",
        };
        await expect(
            verifier.verifyEndpointToken(await accounts.sign(claims, { foreignKey: true })),
        ).rejects.toThrow();
        await expect(
            verifier.verifyEndpointToken(await accounts.sign({ ...claims, eid: undefined })),
        ).rejects.toThrow("not an endpoint token");
    });
});

async function decide(token: string) {
    return await verifier.verifyRelayAuthorization(`Bearer ${token}`, {
        accountId: OWNER,
        endpointId,
    });
}

/** Fill the placeholders a table row cannot know before the fixture exists. */
function substitute(claims: Record<string, unknown> | undefined): Record<string, unknown> {
    const replace = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(replace);
        if (typeof value !== "string") return value;
        return value
            .replace("ISSUER", accounts.url)
            .replace("RELAY", accounts.relayUrl)
            .replace("SELF", endpointId)
            .replace("OTHER", otherEndpointId);
    };
    return Object.fromEntries(
        Object.entries(claims ?? {}).map(([name, value]) => [name, replace(value)]),
    );
}

/** Run the device grant against the fake the way a daemon would, returning the new endpoint. */
async function linkEndpoint(account: string): Promise<string> {
    const authorization = (await (
        await fetch(`${accounts.url}/device/authorize`, {
            body: new URLSearchParams({
                client_id: "happy-agent",
                name: randomUUID(),
                platform: "linux",
            }),
            method: "POST",
        })
    ).json()) as { device_code: string; user_code: string };
    accounts.approve(authorization.user_code, account);
    const tokens = (await (
        await fetch(`${accounts.url}/token`, {
            body: new URLSearchParams({
                client_id: "happy-agent",
                device_code: authorization.device_code,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
            method: "POST",
        })
    ).json()) as { endpoint_id: string };
    return tokens.endpoint_id;
}
