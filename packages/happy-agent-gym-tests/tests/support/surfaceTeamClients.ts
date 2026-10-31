import { generateKeyPairSync, sign } from "node:crypto";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGymOptions } from "@slopus/happy-agent-gym";

/** Enables real local JWT authentication on a test-owned installation, without external services. */
export async function surfaceTeamClients(options: AgentGymOptions = {}) {
    // A public asymmetric key avoids daemon environment injection and keeps this fixture self-contained.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const config = `
[feature.team]
enabled = true
host = "127.0.0.1"
port = 0
authentication = "jwt"
owner_user_id = "alice"
[feature.team.jwt]
name = "Surface test sign-in"
authorization_url = "https://surface.test/authorize"
token_url = "https://surface.test/token"
client_id = "surface-tests"
issuer = "https://surface.test"
audience = "surface-tests"
algorithms = ["EdDSA"]
public_key = """
${pem}"""
`;
    const tokenFor = (subject: string) => {
        const encoded = [
            { alg: "EdDSA", typ: "JWT" },
            {
                sub: subject,
                iss: "https://surface.test",
                aud: "surface-tests",
                exp: Math.floor(Date.now() / 1000) + 3600,
            },
        ]
            .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
            .join(".");
        return `${encoded}.${sign(null, Buffer.from(encoded), privateKey).toString("base64url")}`;
    };
    const gym = await createAgentGym({
        ...options,
        config: `${options.config ?? ""}\n${config}`,
        teamUser: { token: tokenFor("alice"), name: "Alice" },
    });
    const clientFor = (subject: string) => {
        return new HappyAgentClient({
            endpoint: "http://happy-agent.gym",
            fetch: (input, init) => {
                const original = new Request(input, init);
                const endpoint = gym.daemon.httpUrl;
                if (endpoint === undefined)
                    throw new Error("The team fixture has no HTTP endpoint.");
                const url = new URL(original.url);
                return fetch(new Request(new URL(url.pathname + url.search, endpoint), original));
            },
            token: tokenFor(subject),
        });
    };
    const alice = clientFor("alice");
    const bob = clientFor("bob");
    const onboard = async (client: HappyAgentClient, name: string) => {
        const initial = (await client.getProfile()).profile;
        return (await client.updateProfile({ name }, { ifMatch: initial.version })).profile.userId!;
    };
    try {
        return {
            gym,
            alice,
            bob,
            aliceId: (await alice.getProfile()).profile.userId!,
            bobId: await onboard(bob, "Bob"),
            clientFor,
            onboard,
        };
    } catch (error) {
        await gym.dispose();
        throw error;
    }
}
