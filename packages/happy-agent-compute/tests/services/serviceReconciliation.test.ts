import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowEverything } from "../../sources/ComputePermissions.js";
import {
    NativeProcessManager,
    type ManagedProcess,
} from "../../sources/processes/NativeProcessManager.js";
import { createHostServices } from "../../sources/services/createHostServices.js";
import { reconcileServiceExecution } from "../../sources/services/reconcileServiceExecution.js";

vi.mock("../../sources/services/resolveServiceCgroupParent.js", () => ({
    resolveServiceCgroupParent: async () => "/test-delegation",
}));
vi.mock("../../sources/services/resolveServiceInputs.js", () => ({
    resolveServiceInputs: async () => [{ source: "/selected/input", destination: "unused" }],
}));
vi.mock("../../sources/services/reconcileServiceExecution.js", () => ({
    reconcileServiceExecution: vi.fn(async () => {}),
}));

afterEach(() => {
    vi.restoreAllMocks();
});

describe.runIf(process.platform !== "win32")("service reconciliation ownership", () => {
    it("releases active capacity and process-group ownership after a failed completion is independently confirmed", async () => {
        const directory = await realpath(await mkdtemp(join(tmpdir(), "svc-proof-")));
        const ctx = createRootContext().named("service-reconciliation-test");
        const manager = new NativeProcessManager(ctx);
        const confirmed = vi.spyOn(manager, "releaseConfirmedProcessGroup");
        // This unit test scripts the process boundary. The separate live lane proves native
        // namespace/cgroup teardown; no process, namespace or host security change occurs here.
        const managed = {
            id: "scripted-process",
            pid: null,
            status: "exited",
            wait: async () => ({ exitCode: 125, killed: false }),
            kill: async () => {},
        } as unknown as ManagedProcess;
        vi.spyOn(manager, "start").mockResolvedValue(managed);
        const services = createHostServices({ ctx, cwd: directory, processManager: manager });
        try {
            await mkdir(join(directory, "controls"), { mode: 0o700 });
            for (let index = 0; index < 33; index += 1) {
                const id = `s${index.toString().padStart(23, "0")}`;
                const execution = { id, directory: join(directory, "controls", id) };
                vi.mocked(reconcileServiceExecution).mockRejectedValueOnce(
                    new Error("Temporary cleanup proof failure."),
                );
                const service = await services.start(ctx, {
                    execution,
                    command: "unused",
                    cwd: ".",
                    port: 4187,
                    tty: false,
                    permissions: allowEverything(),
                    sandbox: {
                        inputs: ["unused"],
                        scratch: [],
                        outbound: [],
                        limits: { memoryMiB: 128, processes: 8 },
                    },
                });
                await expect(service.completion).rejects.toThrow("Temporary cleanup proof failure");
                if (index === 32)
                    await expect(services.dispose(ctx)).rejects.toThrow(
                        "Temporary cleanup proof failure",
                    );
                await services.reconcile(ctx, execution);
            }
            expect(confirmed).toHaveBeenCalledTimes(33);
            await expect(services.dispose(ctx)).resolves.toBeUndefined();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
