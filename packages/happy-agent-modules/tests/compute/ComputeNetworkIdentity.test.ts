import { PassThrough, type Duplex } from "node:stream";

import { networkIdSchema } from "@slopus/happy-agent-client";
import { withAgentConfig } from "@slopus/happy-agent-base";
import type { Compute, ComputeConnectOptions } from "@slopus/happy-agent-compute";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    ComputeModule,
    LocalExecutionDisabledError,
    SecretsModule,
    type HostComputeProvider,
} from "../../sources/index.js";
import { testConfig } from "../support/computeModule.js";
import { FakeCompute } from "./support/FakeCompute.js";

const ctx = createRootContext().named("happy-agent-modules-compute-network-identity");

/** A machine, as the compute package builds one, that records every connection asked of it. */
function networked(name: string, cwd: string): Compute & { readonly opened: string[] } {
    const machine = new FakeCompute(cwd);
    const opened: string[] = [];
    return {
        id: "fake",
        kind: machine.kind,
        cwd: machine.cwd,
        fs: machine.fs,
        shell: machine.shell,
        opened,
        network: {
            connect: async (_ctx: Context, options: ComputeConnectOptions): Promise<Duplex> => {
                opened.push(`${name} ${options.host}:${String(options.port)}`);
                return new PassThrough();
            },
        },
        dispose: async (disposeCtx: Context) => await machine.dispose(disposeCtx),
    };
}

/**
 * Where folders are, as the runners module answers: this computer, and the runners configured.
 * Its machines persist across "restarts" of a compute module, as a runner outlives a daemon.
 */
function runners(configured: readonly string[]) {
    const products = new Map<string, ReturnType<typeof networked>>();
    const agents: ReturnType<typeof networked>[] = [];
    const product = (runnerId: string | undefined) => {
        const key = runnerId ?? "here";
        let machine = products.get(key);
        if (machine === undefined) {
            machine = networked(key, "/home");
            products.set(key, machine);
        }
        return machine;
    };
    return {
        products,
        agents,
        module: {
            localExecution: configured.length === 0,
            has: (runnerId: string) => configured.includes(runnerId),
            userFor: async () => undefined,
            assertLocalExecution: () => {
                if (configured.length > 0) throw new LocalExecutionDisabledError();
            },
            machine: async (runnerId?: string) => product(runnerId),
            agentMachine: async (
                _ctx: Context,
                input: { readonly agentId: string; readonly cwd: string },
            ) => {
                const machine = networked(`agent ${input.agentId}`, input.cwd);
                agents.push(machine);
                return machine;
            },
        } as never,
    };
}

/** An agent's machine on this computer, able to open connections. */
class NetworkedCompute extends FakeCompute {
    readonly network = {
        connect: async (): Promise<Duplex> => new PassThrough(),
    };
}

function compute(where: ReturnType<typeof runners>): ComputeModule {
    const provider: HostComputeProvider = {
        id: "host",
        create: async (_createCtx, config) => new NetworkedCompute(config.cwd),
    };
    return ComputeModule.withProvider(testConfig, new SecretsModule(), provider, where.module);
}

function on(machine: Record<string, unknown>): Context {
    return withAgentConfig(ctx, { modules: { compute: machine } });
}

async function connectThrough(module: ComputeModule, networkId: string): Promise<Duplex> {
    const connect = await module.namedNetwork(networkId);
    if (connect === undefined) throw new Error(`${networkId} is not served.`);
    return await connect(ctx, { host: "localhost", port: 3000 });
}

describe("ComputeModule network identity", () => {
    it("names one network for this computer, kept when agents come and go and across restarts", async () => {
        const where = runners([]);
        const first = compute(where);
        expect(await first.networkId(on({ cwd: "/workspace/a" }), "agenta")).toBe("host");
        expect(await first.networkId(on({ cwd: "/workspace/b" }), "agentb")).toBe("host");

        const held = await connectThrough(first, "host");
        expect(where.products.get("here")?.opened).toEqual(["here localhost:3000"]);
        // The network is this computer's, not the agent's that first named it.
        await first.archiveAgent(ctx, "agenta");
        expect(held.destroyed).toBe(false);
        await connectThrough(first, "host");
        expect(where.products.get("here")?.opened).toHaveLength(2);
        await first.dispose(ctx);

        const restarted = compute(where);
        await connectThrough(restarted, "host");
        expect(await restarted.networkId(on({ cwd: "/workspace/b" }), "agentb")).toBe("host");
        await restarted.dispose(ctx);
    });

    it("names one network per runner and serves only runners still configured", async () => {
        const where = runners(["studio", "lab"]);
        const module = compute(where);
        const studio = on({ cwd: "/srv/a", runnerId: "studio" });
        expect(await module.networkId(studio, "agenta")).toBe("r-studio");
        expect(await module.networkId(on({ cwd: "/srv/b", runnerId: "studio" }), "agentb")).toBe(
            "r-studio",
        );
        expect(await module.networkId(on({ cwd: "/srv/c", runnerId: "lab" }), "agentc")).toBe(
            "r-lab",
        );

        await connectThrough(module, "r-lab");
        expect(where.products.get("lab")?.opened).toEqual(["lab localhost:3000"]);
        await module.archiveAgent(ctx, "agentc");
        await connectThrough(module, "r-lab");
        expect(where.products.get("lab")?.opened).toHaveLength(2);
        // Work here is disabled once runners are configured, and a removed runner is not served.
        await expect(module.namedNetwork("host")).resolves.toBeUndefined();
        await expect(module.namedNetwork("r-gone")).resolves.toBeUndefined();
        expect(where.products.has("here")).toBe(false);
        await module.dispose(ctx);
    });

    it("gives an agent in a container a network only its running machine serves", async () => {
        const where = runners(["studio"]);
        const first = compute(where);
        const boxed = on({ cwd: "/srv/a", runnerId: "studio", docker: { image: "node:22" } });
        const id = await first.networkId(boxed, "agenta");
        const neighbor = await first.networkId(
            on({ cwd: "/srv/b", runnerId: "studio", docker: { image: "node:22" } }),
            "agentb",
        );
        expect(id).toMatch(/^c-[0-9a-f]{32}$/);
        expect(Value.Check(networkIdSchema, id)).toBe(true);
        expect(neighbor).not.toBe(id);

        await connectThrough(first, id);
        expect(where.agents.flatMap((machine) => machine.opened)).toEqual([
            "agent agenta localhost:3000",
        ]);
        await first.dispose(ctx);

        // A restarted daemon serves the container's network only once its machine is resolved,
        // and then under the same name.
        const restarted = compute(where);
        await expect(restarted.namedNetwork(id)).resolves.toBeUndefined();
        expect(await restarted.networkId(boxed, "agenta")).toBe(id);
        const held = await connectThrough(restarted, id);
        const connect = await restarted.namedNetwork(id);

        await restarted.archiveAgent(ctx, "agenta");
        expect(held.destroyed).toBe(true);
        await expect(restarted.namedNetwork(id)).resolves.toBeUndefined();
        await expect(connect!(ctx, { host: "localhost", port: 3000 })).rejects.toMatchObject({
            code: "ECONNREFUSED",
        });
        expect(
            await restarted.networkId(
                on({ cwd: "/srv/b", runnerId: "studio", docker: { image: "node:22" } }),
                "agentb",
            ),
        ).toBe(neighbor);
        await restarted.dispose(ctx);
    });

    it("keeps a running container's network until its machine starts in a new environment", async () => {
        const where = runners(["studio"]);
        const first = compute(where);
        const id = await first.networkId(
            on({ cwd: "/srv/a", runnerId: "studio", docker: { image: "node:22" } }),
            "agenta",
        );
        // The running machine is never moved, so a newer setting does not rename its network.
        const changed = on({ cwd: "/srv/a", runnerId: "studio", docker: { image: "node:24" } });
        expect(await first.networkId(changed, "agenta")).toBe(id);
        await first.dispose(ctx);

        const rebuilt = compute(where);
        const next = await rebuilt.networkId(changed, "agenta");
        expect(next).toMatch(/^c-[0-9a-f]{32}$/);
        expect(next).not.toBe(id);
        // The old name is no longer served, and never reaches the new container instead.
        await expect(rebuilt.namedNetwork(id)).resolves.toBeUndefined();
        await rebuilt.dispose(ctx);

        // The same image on this computer is another environment again.
        const here = compute(runners([]));
        const local = await here.networkId(
            on({ cwd: "/srv/a", docker: { image: "node:24" } }),
            "agenta",
        );
        expect(local).toMatch(/^c-[0-9a-f]{32}$/);
        expect([id, next]).not.toContain(local);
        await here.dispose(ctx);
    });

    it("refuses to name or serve the network of a machine that cannot open connections", async () => {
        const module = ComputeModule.withProvider(testConfig, new SecretsModule(), {
            id: "host",
            create: async (_createCtx, config) => new FakeCompute(config.cwd),
        });
        await expect(module.networkId(on({ cwd: "/workspace" }), "agenta")).rejects.toMatchObject({
            code: "ENOTSUP",
        });
        await expect(module.namedNetwork("c-0123456789abcdef0123456789abcdef")).resolves.toBe(
            undefined,
        );
        await module.dispose(ctx);
        await expect(module.namedNetwork("host")).resolves.toBeUndefined();
    });
});
