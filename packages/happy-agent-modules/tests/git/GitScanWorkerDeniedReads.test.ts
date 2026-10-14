import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";

const workerOptions: Array<{ hostPolicy?: unknown }> = [];

vi.mock("@slopus/happy-agent-compute", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@slopus/happy-agent-compute")>()),
    createHostCommandWorker: (options: { hostPolicy?: unknown }) => {
        workerOptions.push(options);
        return {
            dispose: async () => {},
            run: async () => ({
                exitCode: 1,
                stderr: "",
                stdout: Buffer.alloc(0),
                timedOut: false,
                truncated: false,
            }),
            warm: () => {},
        };
    },
}));

const { ComputeModule } = await import("../../sources/compute/index.js");
const { GitModule } = await import("../../sources/git/GitModule.js");
const { SecretsModule } = await import("../../sources/secrets/index.js");
const { testConfig } = await import("../support/computeModule.js");

/**
 * The Windows sandbox keeps one deny set per sandbox group, and every setup reconciles the group
 * to the set it was given. A scan worker that denies less than the agent shell therefore revokes
 * the shell's denies, so both must be given the host policy the compute module owns.
 *
 * Scans only use workers on Windows, so this runs there; the constructor wiring itself is covered
 * on every platform by the GitScanWorkers tests.
 */
describe.skipIf(process.platform !== "win32")("Git scan worker denied reads", () => {
    it("creates scan workers with the host policy agent shells use", async () => {
        workerOptions.length = 0;
        const compute = new ComputeModule(testConfig, new SecretsModule());
        const module = new GitModule(testConfig, undefined, compute);
        try {
            await module.beforeStart(createRootContext());
            // The scan itself fails against the stub worker; only the worker it starts matters.
            await module.snapshot(process.cwd()).catch(() => undefined);

            expect(workerOptions).toHaveLength(1);
            expect(workerOptions[0]!.hostPolicy).toEqual(compute.hostPolicy);
            expect(workerOptions[0]!.hostPolicy).toMatchObject({
                privateDirectories: [testConfig.configuration.paths.agentHome],
            });
        } finally {
            module.dispose();
        }
    });
});
