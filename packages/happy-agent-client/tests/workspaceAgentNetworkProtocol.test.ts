import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient, workspaceAgentNetworkResponseSchema } from "../sources/index.js";

describe("agent networks", () => {
    it("reads an agent's network beneath its workspace and opens a network's proxy", async () => {
        const requests: Request[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://daemon/prefix?transport=key",
            token: "daemon-credential",
            fetch: async (input, init) => {
                requests.push(new Request(input, init));
                return Response.json({ networkId: "host" });
            },
        });

        expect(await client.getWorkspaceAgentNetwork("workspace1", "agent1")).toEqual({
            networkId: "host",
        });
        const [read] = requests;
        expect(read?.method).toBe("GET");
        expect(new URL(read!.url).pathname).toBe(
            "/prefix/v0/workspaces/workspace1/agents/agent1/proxy",
        );
        expect(read?.headers.get("authorization")).toBe("Bearer daemon-credential");

        const network = new URL(client.networkProxyUrl("r-build-box"));
        expect(network.pathname).toBe("/prefix/v0/networks/r-build-box/proxy");
        expect(network.searchParams.get("transport")).toBe("key");
        expect(new URL(client.connection("build-box").networkProxyUrl("host")).pathname).toBe(
            "/prefix/v0/connections/build-box/api/v0/networks/host/proxy",
        );
    });

    it("passes the network's kind through, directly and through a connection", async () => {
        const paths: string[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://daemon/",
            token: "credential",
            fetch: async (input, init) => {
                const url = new URL(new Request(input, init).url);
                paths.push(url.pathname);
                return Response.json(
                    url.pathname.startsWith("/v0/connections/")
                        ? { networkId: "r-build-box", kind: "runner" }
                        : { networkId: "host", kind: "host" },
                );
            },
        });

        expect(await client.getWorkspaceAgentNetwork("workspace1", "agent1")).toEqual({
            networkId: "host",
            kind: "host",
        });
        expect(
            await client.connection("build-box").getWorkspaceAgentNetwork("workspace1", "agent1"),
        ).toEqual({ networkId: "r-build-box", kind: "runner" });
        expect(paths).toEqual([
            "/v0/workspaces/workspace1/agents/agent1/proxy",
            "/v0/connections/build-box/api/v0/workspaces/workspace1/agents/agent1/proxy",
        ]);
    });

    it("accepts every specified kind and an older daemon that omits it", () => {
        for (const kind of ["host", "runner", "container", undefined])
            expect(
                Value.Check(workspaceAgentNetworkResponseSchema, {
                    networkId: "host",
                    ...(kind === undefined ? {} : { kind }),
                }),
            ).toBe(true);
        for (const kind of ["", "Host", "docker", null])
            expect(
                Value.Check(workspaceAgentNetworkResponseSchema, { networkId: "host", kind }),
            ).toBe(false);
    });

    it("bounds a network identifier to the specified opaque form", () => {
        for (const networkId of ["host", "r-build_box", "c-a1b2-0f9e", "a".repeat(128)])
            expect(Value.Check(workspaceAgentNetworkResponseSchema, { networkId })).toBe(true);
        for (const networkId of ["", "-host", "Host", "a/b", "a".repeat(129), "a b"])
            expect(Value.Check(workspaceAgentNetworkResponseSchema, { networkId })).toBe(false);
    });

    it("refuses to address a network outside the opaque form", () => {
        const client = new HappyAgentClient({ endpoint: "http://daemon/", token: "credential" });
        const longest = "a".repeat(128);
        expect(new URL(client.networkProxyUrl(longest)).pathname).toBe(
            `/v0/networks/${longest}/proxy`,
        );
        for (const networkId of ["..", ".", "a/b", "", "a".repeat(129), "-host", "a%2fb", "a?b"])
            expect(() => client.networkProxyUrl(networkId)).toThrow("The network ID is invalid.");
    });
});
