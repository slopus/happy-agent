import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentGym, GymHttpClient, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("remote roster through the public Happy Agent API", () => {
    it("uses a fixed socket credential and returns a secret-free roster without contacting remotes", async () => {
        const token = "m".repeat(43);
        const remoteToken = "r".repeat(43);
        const gym = await createAgentGym({
            config: [
                "[api]",
                `token = "${token}"`,
                "[connections.builder]",
                'name = "Build Mac"',
                'address = "tcUnreachable"',
                `token = "${remoteToken}"`,
                "[connections.engineering]",
                'name = "Engineering"',
                'address = "tcTeam"',
                'workos_organization_id = "org_test"',
                "[connections.hidden]",
                "enabled = false",
            ].join("\n"),
        });
        running.push(gym);
        expect(gym.token).toBe(token);
        expect((await readFile(join(gym.happyHome, "agent", "token"), "utf8")).trim()).toBe(token);
        expect(await gym.client.listConnections()).toEqual({
            connections: [
                { id: "builder", name: "Build Mac", authentication: "bearer" },
                {
                    id: "engineering",
                    name: "Engineering",
                    authentication: "workos",
                    organizationId: "org_test",
                },
            ],
        });
        const config = JSON.stringify(await gym.client.getConfig());
        expect(config).not.toContain(remoteToken);
        expect(config).not.toContain(token);
        expect(config).not.toContain("tcUnreachable");
        await expect(gym.client.connection("hidden").getHealth()).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
        await expect(gym.client.connection("missing").getHealth()).rejects.toMatchObject({
            status: 404,
            code: "not_found",
        });
        const unauthorized = new GymHttpClient({ socketPath: gym.socketPath, token: "wrong" });
        expect(await unauthorized.get("/v0/connections")).toMatchObject({ status: 401 });
        expect(await unauthorized.get("/v0/connections/builder/api/v0/health")).toMatchObject({
            status: 401,
        });
        expect(
            await gym.raw.post("/v0/connections", { id: "unauthorized-mutation" }),
        ).toMatchObject({ status: 404 });
        expect((await gym.client.getHealth()).ready).toBe(true);
    });
});
