import { createAgentGym, GymHttpClient, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

interface ErrorBody {
    readonly code?: unknown;
    readonly error?: unknown;
    readonly [key: string]: unknown;
}

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

async function start(): Promise<AgentGym> {
    const gym = await createAgentGym({ timeoutMs: 15_000 });
    running.add(gym);
    return gym;
}

function errorBody(value: unknown): ErrorBody {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return value as ErrorBody;
}

function expectFailure(
    response: { readonly body: unknown; readonly status: number },
    status: number,
    code: string,
): ErrorBody {
    expect(response.status).toBe(status);
    const body = errorBody(response.body);
    expect(body).toMatchObject({
        code,
        error: expect.any(String),
    });
    return body;
}

describe("the closed Happy Agent API contract", () => {
    it("keeps successful and failed JSON responses cache-free and self-describing", async () => {
        const gym = await start();

        const greeting = await gym.raw.get("/");
        expect(greeting.status).toBe(200);
        expect(greeting.headers["cache-control"]).toBe("no-store");
        expect(greeting.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(greeting.body).toEqual({ text: "Welcome to Happy Agent!" });

        const health = await gym.raw.get("/v0/health");
        expect(health.status).toBe(200);
        expect(health.headers["cache-control"]).toBe("no-store");
        expect(health.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(health.body).toMatchObject({
            healthy: true,
            ready: true,
            status: "ready",
            version: {
                daemon: "gym",
                protocol: expect.any(Number),
            },
        });

        const missing = await gym.raw.get("/v0/projects/contract-missing");
        const missingBody = expectFailure(missing, 404, "not_found");
        expect(missing.headers["cache-control"]).toBe("no-store");
        expect(missing.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(Object.keys(missingBody).sort()).toEqual(["code", "error"]);

        await expect(gym.client.getGreeting()).resolves.toEqual({
            text: "Welcome to Happy Agent!",
        });
    });

    it("rejects authorization variants without leaking credentials", async () => {
        const gym = await start();
        const wrongToken = new GymHttpClient({
            socketPath: gym.socketPath,
            token: "a".repeat(43),
        });
        const emptyToken = new GymHttpClient({
            socketPath: gym.socketPath,
            token: "",
        });

        const wrong = await wrongToken.get("/v0/health");
        const wrongBody = expectFailure(wrong, 401, "unauthorized");
        expect(wrong.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(wrong.headers["cache-control"]).toBe("no-store");
        expect(JSON.stringify(wrongBody)).not.toContain(gym.token);
        expect(JSON.stringify(wrongBody)).not.toContain(gym.happyHome);

        const empty = await emptyToken.get("/v0/health");
        expectFailure(empty, 401, "unauthorized");
        expect(empty.headers["content-type"]).toBe("application/json; charset=utf-8");
        expect(empty.headers["cache-control"]).toBe("no-store");

        // A token-shaped path is still opaque input; an error must never reflect it.
        const tokenPath = await gym.raw.get(`/v0/projects/${encodeURIComponent(gym.token)}`);
        const tokenPathBody = expectFailure(tokenPath, 404, "not_found");
        expect(JSON.stringify(tokenPathBody)).not.toContain(gym.token);

        await expect(gym.client.getHealth()).resolves.toMatchObject({ ready: true });
    });

    it("returns stable codes for malformed, unsupported, missing-version, and oversized requests", async () => {
        const gym = await start();

        // A body with the wrong JSON shape is a malformed request even though the bytes are JSON.
        const wrongShape = await gym.raw.request(
            "POST",
            "/v0/projects",
            "not an onboarding request",
        );
        expectFailure(wrongShape, 400, "invalid_request");

        // No content type/body is deliberately sent to a JSON endpoint.
        const unsupportedMedia = await gym.raw.request("POST", "/v0/projects", undefined);
        expectFailure(unsupportedMedia, 400, "invalid_request");

        const missingIfMatch = await gym.raw.patch("/v0/profile", {
            name: "must not apply",
        });
        expectFailure(missingIfMatch, 400, "invalid_request");
        expect((await gym.client.getProfile()).profile.name).toBeNull();

        const profile = await gym.client.getProfile();
        const oversizedPhoto = await gym.client
            .setProfilePhoto(
                {
                    contentType: "image/png",
                    data: new Uint8Array(8 * 1024 * 1024 + 1),
                },
                { ifMatch: profile.profile.version },
            )
            .then(
                () => undefined,
                (error: unknown) => error as { readonly code?: unknown; readonly status?: unknown },
            );
        expect(oversizedPhoto).toMatchObject({ code: "too_large", status: 413 });
        await expect(gym.client.getProfile()).resolves.toEqual(profile);

        const unsupportedMethod = await gym.raw.request("POST", "/");
        expectFailure(unsupportedMethod, 404, "not_found");

        await expect(gym.client.getGreeting()).resolves.toEqual({
            text: "Welcome to Happy Agent!",
        });
    });

    it("does not expose paths or credentials in rejected project input", async () => {
        const gym = await start();
        const privatePath = `${gym.happyHome}/not-a-project`;

        const response = await gym.raw.post("/v0/projects", { path: privatePath });
        const body = expectFailure(response, 400, "invalid_request");
        const encoded = JSON.stringify(body);
        expect(encoded).not.toContain(privatePath);
        expect(encoded).not.toContain(gym.happyHome);
        expect(encoded).not.toContain(gym.token);

        const invalidProject = await gym.raw.post("/v0/projects", { path: 123 });
        expectFailure(invalidProject, 400, "invalid_request");
        await expect(gym.client.getGreeting()).resolves.toMatchObject({
            text: "Welcome to Happy Agent!",
        });
    });

    it("keeps removed compatibility routes absent", async () => {
        const gym = await start();
        const project = (await gym.client.listProjects()).projects[0];
        if (project === undefined) throw new Error("The gym did not expose its root project.");

        const removed = [
            "/v0/sessions",
            "/v0/sessions/legacy",
            "/v0/models",
            "/v0/catalog",
            "/v0/timeline",
            "/v0/events/live",
            "/v0/events/trim",
            "/v0/provider-usage",
            "/v0/profiles",
            "/v0/secrets",
            "/v0/file-paths",
            `/v0/projects/${project.id}/workspaces`,
            `/v0/projects/${project.id}/terminals`,
            `/v0/projects/${project.id}/files`,
            `/v0/projects/${project.id}/git`,
        ] as const;

        for (const path of removed) {
            const response = await gym.raw.get(path);
            const body = expectFailure(response, 404, "not_found");
            expect(JSON.stringify(body)).not.toContain(gym.token);
            expect(JSON.stringify(body)).not.toContain(gym.happyHome);
        }

        await expect(gym.client.listProjects()).resolves.toMatchObject({
            projects: expect.any(Array),
        });
    });
});
