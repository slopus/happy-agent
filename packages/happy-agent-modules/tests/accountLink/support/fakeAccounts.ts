import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

interface FakeEndpoint {
    readonly account: string;
    readonly id: string;
    /** Its refresh family is revoked: by the daemon, by the owner, or by a replayed token. */
    revoked: boolean;
    liveRefresh: string;
    reachable: boolean;
    seen: number;
}

interface FakeDeviceGrant {
    readonly deviceCode: string;
    readonly name: string;
    readonly platform: string;
    readonly userCode: string;
    outcome: "pending" | "denied" | { readonly account: string };
}

export interface TokenOverrides {
    /** Replace or remove claims after the defaults are applied; `undefined` removes one. */
    readonly claims?: Record<string, unknown>;
    readonly expiresInSeconds?: number;
    readonly header?: { readonly alg?: string; readonly kid?: string | null };
    /** Sign with a key the accounts key set does not publish. */
    readonly foreignKey?: boolean;
}

/**
 * A stand-in for happy-accounts written from the shared contract: the device grant, rotating
 * refresh tokens that revoke on reuse, the endpoint directory routes, and the key set.
 */
export class FakeAccounts {
    readonly relayUrl: string;
    readonly requests: string[] = [];
    readonly #endpoints = new Map<string, FakeEndpoint>();
    readonly #grants = new Map<string, FakeDeviceGrant>();
    #foreign!: SigningKey;
    #jwk!: JWK;
    #key!: SigningKey;
    #server!: Server;
    /** Set to answer every key set request with this status instead. */
    jwksStatus: number | undefined;
    jwksRequests = 0;
    accessTtlSeconds = 900;
    deviceInterval = 1;

    private constructor(relayUrl: string) {
        this.relayUrl = relayUrl;
    }

    static async start(relayUrl = "https://relay.accounts.test"): Promise<FakeAccounts> {
        const accounts = new FakeAccounts(relayUrl);
        const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
        accounts.#key = pair.privateKey;
        accounts.#jwk = {
            ...(await exportJWK(pair.publicKey)),
            alg: "EdDSA",
            kid: "k1",
            use: "sig",
        };
        accounts.#foreign = (await generateKeyPair("EdDSA", { crv: "Ed25519" })).privateKey;
        accounts.#server = createServer((request, response) => {
            void accounts.#handle(request).then(
                ({ body, status }) => {
                    response.writeHead(status, { "content-type": "application/json" });
                    response.end(body === undefined ? "" : JSON.stringify(body));
                },
                () => {
                    response.writeHead(500);
                    response.end();
                },
            );
        });
        await new Promise<void>((resolve) => accounts.#server.listen(0, "127.0.0.1", resolve));
        return accounts;
    }

    get url(): string {
        return `http://127.0.0.1:${String((this.#server.address() as AddressInfo).port)}`;
    }

    async close(): Promise<void> {
        this.#server.closeAllConnections();
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }

    get pendingUserCodes(): readonly string[] {
        return [...this.#grants.values()]
            .filter((grant) => grant.outcome === "pending")
            .map((grant) => grant.userCode);
    }

    grant(userCode: string): FakeDeviceGrant {
        const grant = [...this.#grants.values()].find((entry) => entry.userCode === userCode);
        if (grant === undefined) throw new Error("No such user code.");
        return grant;
    }

    /** What the browser page does: the signed-in account approves or refuses the code. */
    approve(userCode: string, account: string): void {
        this.grant(userCode).outcome = { account };
    }

    deny(userCode: string): void {
        this.grant(userCode).outcome = "denied";
    }

    endpoint(id: string): FakeEndpoint {
        const endpoint = this.#endpoints.get(id);
        if (endpoint === undefined) throw new Error("No such endpoint.");
        return endpoint;
    }

    get endpoints(): readonly FakeEndpoint[] {
        return [...this.#endpoints.values()];
    }

    /** The owner removes the computer from the account's devices. */
    revoke(endpointId: string): void {
        this.endpoint(endpointId).revoked = true;
    }

    /** A relay token as accounts would mint it for the owner, bent by `overrides`. */
    async relayToken(endpointId: string, overrides: TokenOverrides = {}): Promise<string> {
        const endpoint = this.endpoint(endpointId);
        return await this.sign(
            {
                aud: `${this.relayUrl}/e/${endpointId}`,
                eid: endpointId,
                sub: endpoint.account,
                typ: "relay",
            },
            overrides,
        );
    }

    async sign(claims: Record<string, unknown>, overrides: TokenOverrides = {}): Promise<string> {
        const now = Math.floor(Date.now() / 1_000);
        const payload: Record<string, unknown> = {
            exp: now + (overrides.expiresInSeconds ?? this.accessTtlSeconds),
            iat: now,
            iss: this.url,
            ...claims,
            ...overrides.claims,
        };
        for (const [name, value] of Object.entries(payload)) {
            if (value === undefined) delete payload[name];
        }
        const kid = overrides.header?.kid === undefined ? "k1" : overrides.header.kid;
        return await new SignJWT(payload)
            .setProtectedHeader({ alg: "EdDSA", ...(kid === null ? {} : { kid }) })
            .sign(overrides.foreignKey === true ? this.#foreign : this.#key);
    }

    async #handle(request: IncomingMessage): Promise<{ status: number; body?: unknown }> {
        const url = new URL(request.url ?? "/", this.url);
        this.requests.push(`${request.method ?? ""} ${url.pathname}`);
        if (url.pathname === "/.well-known/jwks.json") {
            this.jwksRequests += 1;
            if (this.jwksStatus !== undefined) return { status: this.jwksStatus };
            return { body: { keys: [this.#jwk] }, status: 200 };
        }
        const body = await readBody(request);
        if (request.method === "POST" && url.pathname === "/device/authorize") {
            const form = new URLSearchParams(body);
            if (form.get("client_id") !== "happy-agent") {
                return { body: { error: "invalid_client" }, status: 400 };
            }
            const grant: FakeDeviceGrant = {
                deviceCode: randomUUID(),
                name: form.get("name") ?? "",
                outcome: "pending",
                platform: form.get("platform") ?? "",
                userCode: `${randomUUID().slice(0, 4)}-${randomUUID().slice(0, 4)}`.toUpperCase(),
            };
            this.#grants.set(grant.deviceCode, grant);
            return {
                body: {
                    device_code: grant.deviceCode,
                    expires_in: 600,
                    interval: this.deviceInterval,
                    user_code: grant.userCode,
                    verification_uri: `${this.url}/device`,
                    verification_uri_complete: `${this.url}/device?user_code=${grant.userCode}`,
                },
                status: 200,
            };
        }
        if (request.method === "POST" && url.pathname === "/revoke") {
            // RFC 7009: the family is revoked and the answer says nothing about the token.
            const presented = new URLSearchParams(body).get("token") ?? "";
            for (const endpoint of this.#endpoints.values()) {
                if (endpoint.liveRefresh === presented) endpoint.revoked = true;
            }
            return { status: 200 };
        }
        if (request.method === "POST" && url.pathname === "/token") {
            return await this.#token(new URLSearchParams(body));
        }
        const match = /^\/v1\/endpoints\/([^/]+)(\/seen)?$/u.exec(url.pathname);
        if (match !== null) {
            const endpoint = this.#endpoints.get(decodeURIComponent(match[1] ?? ""));
            const bearer = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
            if (endpoint === undefined || endpoint.revoked) return { status: 404 };
            if (bearer === undefined || !this.#issuedAccess.has(bearer)) return { status: 401 };
            if (this.#issuedAccess.get(bearer) !== endpoint.id) return { status: 403 };
            if (request.method === "POST" && match[2] !== undefined) {
                endpoint.seen += 1;
                return { status: 204 };
            }
            if (request.method === "PATCH" && match[2] === undefined) {
                const patch = JSON.parse(body) as { reachable?: boolean };
                if (patch.reachable !== undefined) endpoint.reachable = patch.reachable;
                return { body: { id: endpoint.id, reachable: endpoint.reachable }, status: 200 };
            }
        }
        return { status: 404 };
    }

    readonly #issuedAccess = new Map<string, string>();

    async #token(form: URLSearchParams): Promise<{ status: number; body?: unknown }> {
        const refuse = (error: string) => ({ body: { error }, status: 400 });
        if (form.get("client_id") !== "happy-agent") return refuse("invalid_client");
        const grantType = form.get("grant_type");
        if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
            const grant = this.#grants.get(form.get("device_code") ?? "");
            if (grant === undefined) return refuse("expired_token");
            if (grant.outcome === "pending") return refuse("authorization_pending");
            this.#grants.delete(grant.deviceCode);
            if (grant.outcome === "denied") return refuse("access_denied");
            const endpoint: FakeEndpoint = {
                account: grant.outcome.account,
                revoked: false,
                id: randomUUID(),
                liveRefresh: "",
                reachable: false,
                seen: 0,
            };
            this.#endpoints.set(endpoint.id, endpoint);
            return { body: await this.#issue(endpoint), status: 200 };
        }
        if (grantType === "refresh_token") {
            const presented = form.get("refresh_token") ?? "";
            const endpoint = [...this.#endpoints.values()].find((entry) =>
                presented.startsWith(`refresh.${entry.id}.`),
            );
            if (endpoint === undefined || endpoint.revoked) return refuse("invalid_grant");
            if (endpoint.liveRefresh !== presented) {
                // A retired token came back: the family is revoked, as accounts does.
                endpoint.revoked = true;
                return refuse("invalid_grant");
            }
            return { body: await this.#issue(endpoint), status: 200 };
        }
        return refuse("unsupported_grant_type");
    }

    async #issue(endpoint: FakeEndpoint): Promise<Record<string, unknown>> {
        endpoint.liveRefresh = `refresh.${endpoint.id}.${randomUUID()}`;
        const access = await this.sign({
            aud: `${this.relayUrl}/`,
            eid: endpoint.id,
            sub: endpoint.account,
            typ: "endpoint",
        });
        this.#issuedAccess.set(access, endpoint.id);
        return {
            access_token: access,
            endpoint_id: endpoint.id,
            expires_in: this.accessTtlSeconds,
            refresh_token: endpoint.liveRefresh,
            token_type: "Bearer",
        };
    }
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
}
