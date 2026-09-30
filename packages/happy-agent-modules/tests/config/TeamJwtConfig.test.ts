import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadHappyAgentConfiguration } from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
});

async function load(toml: string) {
    const root = await mkdtemp(join(tmpdir(), "happy-agent-config-team-jwt-"));
    temporaryDirectories.push(root);
    const directory = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "happy.toml"), toml);
    return await loadHappyAgentConfiguration(join(root, ".happy"));
}

const team = [
    "[feature.team]",
    "enabled = true",
    'authentication = "jwt"',
    'owner_user_id = "owner-1"',
].join("\n");

function jwt(lines: readonly string[]): string {
    return [
        "[feature.team.jwt]",
        'name = "Acme SSO"',
        'authorization_url = "https://sso.acme.example/oauth/authorize"',
        'token_url = "https://sso.acme.example/oauth/token"',
        'client_id = "happy"',
        'issuer = "https://sso.acme.example"',
        'audience = "happy-agent"',
        ...lines,
    ].join("\n");
}

describe("JWT team authentication configuration", () => {
    it("resolves a JWKS key source with a default user ID claim", async () => {
        const configuration = await load(
            `${team}\n${jwt([
                'algorithms = ["RS256", "ES256"]',
                'jwks_url = "https://sso.acme.example/.well-known/jwks.json"',
            ])}\n`,
        );

        expect(configuration.values.feature.team).toMatchObject({
            authentication: "jwt",
            enabled: true,
            jwt: {
                algorithms: ["RS256", "ES256"],
                audience: "happy-agent",
                issuer: "https://sso.acme.example",
                key: {
                    refreshIntervalSec: 3_600,
                    type: "jwks",
                    url: "https://sso.acme.example/.well-known/jwks.json",
                },
                authorizationUrl: "https://sso.acme.example/oauth/authorize",
                clientId: "happy",
                name: "Acme SSO",
                tokenUrl: "https://sso.acme.example/oauth/token",
                userIdClaim: "sub",
            },
            ownerUserId: "owner-1",
        });
        expect(configuration.provenance["feature.team.jwt"]).toBe("global");
        expect(configuration.provenance["feature.team.ownerUserId"]).toBe("global");
    });

    it("resolves static public keys and environment secrets without reading the secret", async () => {
        const { publicKey } = generateKeyPairSync("ed25519");
        const pem = publicKey.export({ format: "pem", type: "spki" }).toString();
        const withPublicKey = await load(
            `${team}\n${jwt(['algorithms = ["EdDSA"]', `public_key = """\n${pem}"""`])}\n`,
        );
        expect(withPublicKey.values.feature.team).toMatchObject({
            jwt: { key: { type: "public_key" } },
        });

        const withSecret = await load(
            `${team}\n${jwt([
                'algorithms = ["HS256"]',
                'secret_env = "HAPPY_TEAM_JWT_SECRET"',
                'user_id_claim = "email"',
            ])}\n`,
        );
        expect(withSecret.values.feature.team).toMatchObject({
            jwt: { key: { env: "HAPPY_TEAM_JWT_SECRET", type: "secret" }, userIdClaim: "email" },
        });
        expect(JSON.stringify(withSecret.values)).not.toContain("BEGIN");
    });

    it.each([
        [
            "two key sources",
            jwt([
                'algorithms = ["RS256"]',
                'jwks_url = "https://sso.acme.example/jwks"',
                'secret_env = "SECRET"',
            ]),
            "exactly one of jwks_url, public_key, or secret_env",
        ],
        [
            "no key source",
            jwt(['algorithms = ["RS256"]']),
            "exactly one of jwks_url, public_key, or secret_env",
        ],
        [
            "a symmetric algorithm with a key set",
            jwt(['algorithms = ["HS256"]', 'jwks_url = "https://sso.acme.example/jwks"']),
            "accepts only the RS, PS, ES, and EdDSA algorithms",
        ],
        [
            "an asymmetric algorithm with a secret",
            jwt(['algorithms = ["RS256"]', 'secret_env = "SECRET"']),
            "accepts only the HS256, HS384, HS512 algorithms",
        ],
        [
            "a plain-http key set on a public host",
            jwt(['algorithms = ["RS256"]', 'jwks_url = "http://sso.acme.example/jwks"']),
            "must use https",
        ],
        [
            "a plain-http key set on a host that only looks like loopback",
            jwt(['algorithms = ["RS256"]', 'jwks_url = "http://127.evil.example/jwks"']),
            "must use https",
        ],
        [
            "an invalid public key",
            jwt(['algorithms = ["RS256"]', 'public_key = "not a key"']),
            "PEM-encoded public key",
        ],
    ])("rejects %s", async (_name, table, message) => {
        await expect(load(`${team}\n${table}\n`)).rejects.toThrow(message);
    });

    it("accepts a loopback http sign-in page and rejects the none algorithm", async () => {
        const loopback = await load(
            `${team}\n${jwt(['algorithms = ["HS512"]', 'secret_env = "SECRET"'])}\n`.replace(
                "https://sso.acme.example/oauth/authorize",
                "http://127.0.0.1:8080/authorize",
            ),
        );
        expect(loopback.values.feature.team).toMatchObject({
            jwt: { authorizationUrl: "http://127.0.0.1:8080/authorize" },
        });
        await expect(
            load(`${team}\n${jwt(['algorithms = ["none"]', 'secret_env = "SECRET"'])}\n`),
        ).rejects.toThrow();
    });

    it("resolves an optional refresh endpoint on another origin and a scope", async () => {
        const configuration = await load(
            `${team}\n${jwt([
                'algorithms = ["ES256"]',
                'jwks_url = "https://sso.acme.example/jwks"',
                'refresh_url = "https://refresh.other.example/oauth/refresh"',
                'scope = "happy offline_access"',
            ])}\n`,
        );
        expect(configuration.values.feature.team).toMatchObject({
            jwt: {
                refreshUrl: "https://refresh.other.example/oauth/refresh",
                scope: "happy offline_access",
            },
        });
    });

    it.each([
        ["token_url", 'token_url = "http://sso.acme.example/oauth/token"'],
        ["refresh_url", 'refresh_url = "http://refresh.acme.example/oauth/refresh"'],
        ["authorization_url", 'authorization_url = "https://user:pass@sso.acme.example/x"'],
    ])("rejects an insecure %s", async (name, line) => {
        const base = jwt(['algorithms = ["HS256"]', 'secret_env = "SECRET"']).replace(
            new RegExp(`^${name} = .*$`, "mu"),
            "",
        );
        await expect(load(`${team}\n${base}\n${line}\n`)).rejects.toThrow(
            `feature.team.jwt.${name}`,
        );
    });

    it.each(["authorization_url", "token_url", "client_id"])("requires %s", async (name) => {
        const base = jwt(['algorithms = ["HS256"]', 'secret_env = "SECRET"']).replace(
            new RegExp(`^${name} = .*\\n`, "mu"),
            "",
        );
        await expect(load(`${team}\n${base}\n`)).rejects.toThrow();
    });

    it("configures how often the JWKS is downloaded", async () => {
        const configuration = await load(
            `${team}\n${jwt([
                'algorithms = ["RS256"]',
                'jwks_url = "https://sso.acme.example/jwks"',
                "jwks_refresh_interval_sec = 300",
            ])}\n`,
        );
        expect(configuration.values.feature.team).toMatchObject({
            jwt: { key: { refreshIntervalSec: 300, type: "jwks" } },
        });
        for (const interval of [59, 86_401, 1.5]) {
            await expect(
                load(
                    `${team}\n${jwt([
                        'algorithms = ["RS256"]',
                        'jwks_url = "https://sso.acme.example/jwks"',
                        `jwks_refresh_interval_sec = ${String(interval)}`,
                    ])}\n`,
                ),
            ).rejects.toThrow();
        }
        await expect(
            load(
                `${team}\n${jwt([
                    'algorithms = ["HS256"]',
                    'secret_env = "SECRET"',
                    "jwks_refresh_interval_sec = 300",
                ])}\n`,
            ),
        ).rejects.toThrow("jwks_refresh_interval_sec requires jwks_url");
    });

    it("keeps each method's settings separate", async () => {
        const table = jwt(['algorithms = ["HS256"]', 'secret_env = "SECRET"']);
        await expect(
            load(`${team}\nworkos_organization_id = "org_test123"\n${table}\n`),
        ).rejects.toThrow("cannot also configure WorkOS settings");
        await expect(
            load(`[feature.team]\nenabled = true\nauthentication = "jwt"\n${table}\n`),
        ).rejects.toThrow("requires feature.team.owner_user_id");
        await expect(load(`${team}\n`)).rejects.toThrow("requires a [feature.team.jwt] table");
        await expect(
            load(
                `[feature.team]\nenabled = true\nworkos_organization_id = "org_test123"\nowner_workos_user_id = "user_owner123"\n${table}\n`,
            ),
        ).rejects.toThrow('require authentication = "jwt"');
    });
});
