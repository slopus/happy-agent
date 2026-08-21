import { randomBytes } from "node:crypto";
import {
    createServer,
    type IncomingHttpHeaders,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";

import type { ProjectCreator } from "./types.js";

const MAXIMUM_CONCURRENT_GIT_REQUESTS = 32;
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/u;

export interface GitAuthentication {
    environment: Readonly<Record<string, string>>;
    loopbackPort: number;
}

export interface GitCommandAuthentication extends GitAuthentication {
    activate(): GitCommandAuthenticationLease;
}

export interface GitCommandAuthenticationLease extends GitAuthentication {
    release(): void;
}

export interface RegisterGitCredential {
    creator: ProjectCreator;
    projectId: string;
    repository: string;
    token: string;
}

interface GitCredentialRecord extends RegisterGitCredential {
    capability: string;
}

export interface ForwardGitRequest {
    headers: IncomingHttpHeaders;
    method: "GET" | "POST";
    path: string;
    repository: string;
    request: IncomingMessage;
    response: ServerResponse;
    token: string;
}

export function redactGitAuthenticationText(
    text: string,
    environment: Readonly<NodeJS.ProcessEnv>,
): string {
    let redacted = text;
    for (const [name, value] of Object.entries(environment)) {
        if (value === undefined || !/^GIT_CONFIG_KEY_\d+$/u.test(name)) continue;
        const match = /^url\.(http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}\/).+\.insteadOf$/u.exec(
            value,
        );
        if (match?.[1] === undefined) continue;
        const capability = /\/([a-f0-9]{64})\/$/u.exec(match[1])?.[1];
        redacted = redacted.replaceAll(
            match[1],
            "http://127.0.0.1/[Happy Agent Git authentication]/",
        );
        if (capability !== undefined) {
            redacted = redacted.replaceAll(capability, "[Happy Agent Git authentication]");
        }
    }
    return redacted;
}

export class GitCredentialBroker {
    readonly #forward: (request: ForwardGitRequest) => Promise<void>;
    readonly #commandLeases = new Map<string, string>();
    readonly #records = new Map<string, GitCredentialRecord>();
    readonly #sockets = new Set<Socket>();
    #activeRequests = 0;
    #closed = false;
    #port: number | undefined;
    #server: Server | undefined;
    #starting: Promise<number> | undefined;

    constructor(options: { forward?: (request: ForwardGitRequest) => Promise<void> } = {}) {
        this.#forward = options.forward ?? forwardGitRequest;
    }

    async register(input: RegisterGitCredential): Promise<GitAuthentication> {
        if (this.#closed) throw new Error("The Git credential broker is closed.");
        const repository = validateGitHubRepository(input.repository);
        const token = validateToken(input.token);
        const recordKey = credentialRecordKey(input.projectId, input.creator);
        const current = this.#records.get(recordKey);
        if (
            current !== undefined &&
            current.repository.toLowerCase() !== repository.toLowerCase()
        ) {
            throw new Error("That project credential names a different Git repository.");
        }
        const port = await this.#start();
        if (this.#closed) throw new Error("The Git credential broker is closed.");
        const record: GitCredentialRecord = current ?? {
            capability: randomBytes(32).toString("hex"),
            creator: { ...input.creator },
            projectId: input.projectId,
            repository,
            token,
        };
        record.creator = { ...input.creator };
        record.repository = repository;
        record.token = token;
        this.#records.set(recordKey, record);
        return authenticationFor(port, record);
    }

    authentication(
        projectId: string,
        creator: ProjectCreator,
    ): GitCommandAuthentication | undefined {
        const recordKey = credentialRecordKey(projectId, creator);
        const record = this.#records.get(recordKey);
        if (record === undefined || this.#port === undefined) return undefined;
        return {
            activate: () => {
                const current = this.#records.get(recordKey);
                if (current !== record) {
                    throw new Error("Git authentication changed before the command could start.");
                }
                const capability = randomBytes(32).toString("hex");
                this.#commandLeases.set(capability, recordKey);
                let released = false;
                return {
                    ...authenticationWithCapability(this.#port!, record, capability),
                    release: () => {
                        if (released) return;
                        released = true;
                        this.#commandLeases.delete(capability);
                    },
                };
            },
            environment: {},
            loopbackPort: this.#port,
        };
    }

    daemonAuthentication(
        projectId: string,
        creator: ProjectCreator,
    ): GitAuthentication | undefined {
        const record = this.#records.get(credentialRecordKey(projectId, creator));
        return record === undefined || this.#port === undefined
            ? undefined
            : authenticationFor(this.#port, record);
    }

    revoke(projectId: string): void {
        for (const [key, record] of this.#records) {
            if (record.projectId === projectId) this.#records.delete(key);
        }
        for (const [capability, recordKey] of this.#commandLeases) {
            if (!this.#records.has(recordKey)) this.#commandLeases.delete(capability);
        }
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#commandLeases.clear();
        this.#records.clear();
        for (const socket of this.#sockets) socket.destroy();
        this.#sockets.clear();
        this.#server?.close();
        this.#server = undefined;
        this.#port = undefined;
    }

    async #start(): Promise<number> {
        if (this.#port !== undefined) return this.#port;
        if (this.#starting !== undefined) return await this.#starting;
        this.#starting = new Promise<number>((resolve, reject) => {
            const listen = () => {
                const server = createServer((request, response) => {
                    void this.#handle(request, response);
                });
                this.#server = server;
                server.on("connection", (socket) => {
                    this.#sockets.add(socket);
                    socket.on("error", () => {});
                    socket.once("close", () => this.#sockets.delete(socket));
                });
                server.on("clientError", (_error, socket) => socket.destroy());
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    server.removeListener("error", reject);
                    if (this.#closed) {
                        server.close();
                        reject(new Error("The Git credential broker is closed."));
                        return;
                    }
                    const address = server.address();
                    if (address === null || typeof address === "string") {
                        reject(new Error("The Git credential broker did not bind a TCP port."));
                        return;
                    }
                    if (address.port === 1080 || address.port === 3128) {
                        server.close(listen);
                        return;
                    }
                    this.#port = address.port;
                    resolve(address.port);
                });
            };
            listen();
        }).finally(() => {
            this.#starting = undefined;
        });
        return await this.#starting;
    }

    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        if (this.#closed) return sendError(response, 503, "Git authentication is unavailable.");
        if (this.#activeRequests >= MAXIMUM_CONCURRENT_GIT_REQUESTS) {
            return sendError(response, 429, "Too many Git requests are active.");
        }
        const authorized = authorizeRequest(request, this.#records, this.#commandLeases);
        if (authorized === undefined) return sendError(response, 404, "Git repository not found.");
        this.#activeRequests += 1;
        try {
            await this.#forward({
                headers: request.headers,
                method: authorized.method,
                path: authorized.path,
                repository: authorized.record.repository,
                request,
                response,
                token: authorized.record.token,
            });
        } catch {
            if (!response.headersSent)
                sendError(response, 502, "The Git host could not be reached.");
            else response.destroy();
        } finally {
            this.#activeRequests -= 1;
        }
    }
}

function authenticationFor(port: number, record: GitCredentialRecord): GitAuthentication {
    return authenticationWithCapability(port, record, record.capability);
}

function authenticationWithCapability(
    port: number,
    record: GitCredentialRecord,
    capability: string,
): GitAuthentication {
    const repositoryUrl = `https://github.com/${record.repository}.git`;
    return {
        environment: {
            GCM_INTERACTIVE: "never",
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "credential.helper",
            GIT_CONFIG_KEY_1: `url.http://127.0.0.1:${String(port)}/${capability}/github.com/${record.repository}.git.insteadOf`,
            GIT_CONFIG_VALUE_0: "",
            GIT_CONFIG_VALUE_1: repositoryUrl,
            GIT_TERMINAL_PROMPT: "0",
        },
        loopbackPort: port,
    };
}

function authorizeRequest(
    request: IncomingMessage,
    records: ReadonlyMap<string, GitCredentialRecord>,
    commandLeases: ReadonlyMap<string, string>,
): { method: "GET" | "POST"; path: string; record: GitCredentialRecord } | undefined {
    if (request.method !== "GET" && request.method !== "POST") return undefined;
    const url = new URL(request.url ?? "/", "http://rig-git.local");
    const parts = url.pathname.split("/").filter(Boolean);
    if ((parts.length !== 5 && parts.length !== 6) || parts[1] !== "github.com") return undefined;
    const [capability, _host, owner, repositoryWithGit, firstServicePart, secondServicePart] =
        parts;
    if (
        capability === undefined ||
        owner === undefined ||
        repositoryWithGit === undefined ||
        !repositoryWithGit.endsWith(".git")
    ) {
        return undefined;
    }
    const repository = `${owner}/${repositoryWithGit.slice(0, -4)}`;
    const leasedRecordKey = commandLeases.get(capability);
    const record = [...records].find(([recordKey, candidate]) => {
        const capabilityMatches =
            candidate.capability === capability ||
            (leasedRecordKey !== undefined && recordKey === leasedRecordKey);
        return capabilityMatches && candidate.repository.toLowerCase() === repository.toLowerCase();
    })?.[1];
    if (record === undefined) return undefined;
    if (request.method === "GET") {
        const requestedService = url.searchParams.get("service");
        if (
            parts.length !== 6 ||
            firstServicePart !== "info" ||
            secondServicePart !== "refs" ||
            (requestedService !== "git-upload-pack" && requestedService !== "git-receive-pack")
        ) {
            return undefined;
        }
    } else if (
        parts.length !== 5 ||
        (firstServicePart !== "git-upload-pack" && firstServicePart !== "git-receive-pack") ||
        url.search.length !== 0
    ) {
        return undefined;
    }
    const servicePath = request.method === "GET" ? "info/refs" : (firstServicePart ?? "invalid");
    return {
        method: request.method,
        path: `/${record.repository}.git/${servicePath}${url.search}`,
        record,
    };
}

function credentialRecordKey(projectId: string, creator: ProjectCreator): string {
    return `${projectId}\0${creator.instanceId}\0${creator.profileId}`;
}

async function forwardGitRequest(input: ForwardGitRequest): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const upstream = httpsRequest(
            {
                headers: forwardedHeaders(input.headers, input.token),
                hostname: "github.com",
                method: input.method,
                path: input.path,
                port: 443,
                protocol: "https:",
            },
            (upstreamResponse) => {
                input.response.writeHead(
                    upstreamResponse.statusCode ?? 502,
                    responseHeaders(upstreamResponse.headers),
                );
                upstreamResponse.once("error", reject);
                upstreamResponse.once("end", resolve);
                upstreamResponse.pipe(input.response);
            },
        );
        upstream.once("error", reject);
        input.request.once("aborted", () => upstream.destroy());
        input.response.once("close", () => upstream.destroy());
        input.request.pipe(upstream);
    });
}

function forwardedHeaders(headers: IncomingHttpHeaders, token: string): IncomingHttpHeaders {
    return {
        accept: headers.accept ?? "*/*",
        ...(headers["accept-encoding"] === undefined
            ? {}
            : { "accept-encoding": headers["accept-encoding"] }),
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}`,
        ...(headers["content-encoding"] === undefined
            ? {}
            : { "content-encoding": headers["content-encoding"] }),
        ...(headers["content-length"] === undefined
            ? {}
            : { "content-length": headers["content-length"] }),
        ...(headers["content-type"] === undefined
            ? {}
            : { "content-type": headers["content-type"] }),
        ...(headers["git-protocol"] === undefined
            ? {}
            : { "git-protocol": headers["git-protocol"] }),
        "user-agent": headers["user-agent"] ?? "Happy Agent Git broker",
    };
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
    return {
        ...(headers["cache-control"] === undefined
            ? {}
            : { "cache-control": headers["cache-control"] }),
        ...(headers["content-length"] === undefined
            ? {}
            : { "content-length": headers["content-length"] }),
        ...(headers["content-encoding"] === undefined
            ? {}
            : { "content-encoding": headers["content-encoding"] }),
        ...(headers["content-type"] === undefined
            ? {}
            : { "content-type": headers["content-type"] }),
        ...(headers.location === undefined ? {} : { location: headers.location }),
        ...(headers["www-authenticate"] === undefined
            ? {}
            : { "www-authenticate": headers["www-authenticate"] }),
        "x-content-type-options": "nosniff",
    };
}

function validateGitHubRepository(repository: string): string {
    const parts = repository.split("/");
    if (
        parts.length !== 2 ||
        parts.some((part) => !GITHUB_REPOSITORY_SEGMENT.test(part) || part === "." || part === "..")
    ) {
        throw new Error("The GitHub repository must use the form owner/repository.");
    }
    return repository;
}

function validateToken(token: string): string {
    if (token.length === 0 || token.length > 65_536 || token.includes("\0")) {
        throw new Error("The GitHub token is invalid.");
    }
    return token;
}

function sendError(response: ServerResponse, status: number, message: string): void {
    response.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
    });
    response.end(message);
}
