import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowEverything, computePermissions } from "../../sources/ComputePermissions.js";
import type { ComputeServiceStartOptions } from "../../sources/ComputeServices.js";
import { createHostCompute } from "../../sources/host/createHostCompute.js";
import { resolveServiceInputs } from "../../sources/services/resolveServiceInputs.js";
import {
    readServiceControlFile,
    writeServiceControlFile,
} from "../../sources/services/serviceControlFiles.js";
import { reconcileServiceExecution } from "../../sources/services/reconcileServiceExecution.js";

const ctx = createRootContext().named("service-boundary-tests");
const directories = new Set<string>();
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
        [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.clear();
});

async function fixture() {
    const scratch = join(process.cwd(), ".context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "service-test-"));
    directories.add(directory);
    const cwd = join(directory, "workspace");
    const privateDirectory = join(directory, "private");
    await mkdir(cwd);
    await mkdir(privateDirectory, { mode: 0o700 });
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "server.js"), "selected input");
    const id = "s123456789012345678901234";
    const start: ComputeServiceStartOptions = {
        execution: { id, directory: join(privateDirectory, id) },
        command: "node src/server.js",
        cwd: ".",
        port: 4187,
        tty: false,
        permissions: allowEverything(),
        sandbox: {
            inputs: ["src"],
            scratch: [],
            outbound: [],
            limits: { memoryMiB: 128, processes: 8 },
        },
    };
    const environment = {
        cwd,
        hostPolicy: {
            privateDirectories: [privateDirectory],
            protectedProjectFiles: ["happy.toml"],
        },
    };
    return { directory, cwd, privateDirectory, start, environment };
}

describe.runIf(process.platform !== "win32")("private service boundary", () => {
    it("keeps live inputs and collapses redundant nested selections", async () => {
        const { start, environment, cwd } = await fixture();
        start.sandbox.inputs.push("src/server.js", "src");
        expect(await resolveServiceInputs(environment, start)).toEqual([
            { source: join(cwd, "src"), destination: "src" },
        ]);
        await writeFile(join(cwd, "src", "server.js"), "external edit");
        expect(await readFile(join(cwd, "src", "server.js"), "utf8")).toBe("external edit");
    });
    it("refuses symlinked input sources", async () => {
        const { start, environment, cwd } = await fixture();
        await symlink(join(cwd, "src"), join(cwd, "alias"));
        start.sandbox.inputs = ["alias"];
        await expect(resolveServiceInputs(environment, start)).rejects.toThrow(
            /without following symlinks/u,
        );
    });
    it("refuses protected input files in Full access too", async () => {
        const { start, environment, cwd } = await fixture();
        await writeFile(join(cwd, "happy.toml"), "protected configuration");
        start.sandbox.inputs = ["happy.toml"];
        await expect(resolveServiceInputs(environment, start)).rejects.toThrow(
            /protected control/u,
        );
    });
    it("refuses a selected parent of a declared private credential path", async () => {
        const { start, environment, cwd } = await fixture();
        environment.hostPolicy.privateDirectories.push(join(cwd, "src", "credentials"));
        await expect(resolveServiceInputs(environment, start)).rejects.toThrow(
            /protected control/u,
        );
    });
    it("requires control storage to be protected from ordinary sandbox reads", async () => {
        const { start, environment, directory } = await fixture();
        start.execution.directory = join(directory, start.execution.id);
        await expect(resolveServiceInputs(environment, start)).rejects.toThrow(
            /declared private daemon directory/u,
        );
    });
    it("creates private, exclusive, bounded regular control files", async () => {
        const { privateDirectory } = await fixture();
        const path = join(privateDirectory, "control");
        await writeServiceControlFile(path, "fixture");
        expect(await readServiceControlFile(path, 16)).toBe("fixture");
        await expect(writeServiceControlFile(path, "replacement")).rejects.toThrow();
        await expect(readServiceControlFile(path, 2)).rejects.toThrow(/bounded private regular/u);
        await chmod(path, 0o644);
        await expect(readServiceControlFile(path, 16)).rejects.toThrow(/bounded private regular/u);
    });
    it("does not follow a symlink when reading private control data", async () => {
        const { privateDirectory } = await fixture();
        await writeServiceControlFile(join(privateDirectory, "target"), "fixture");
        await symlink(join(privateDirectory, "target"), join(privateDirectory, "link"));
        await expect(readServiceControlFile(join(privateDirectory, "link"), 16)).rejects.toThrow();
    });
    it("retains execution files when restart evidence is incomplete", async () => {
        const { start } = await fixture();
        await mkdir(start.execution.directory, { mode: 0o700 });
        await writeFile(join(start.execution.directory, "retained"), "keep this");
        await expect(reconcileServiceExecution(start.execution)).rejects.toThrow(
            /missing or incomplete/u,
        );
        expect(await readFile(join(start.execution.directory, "retained"), "utf8")).toBe(
            "keep this",
        );
    });
    it("refuses an unsupported resource boundary before starting or creating controls", async () => {
        const { start, environment, directory } = await fixture();
        const compute = createHostCompute({
            ctx,
            ...environment,
            serviceCgroupParent: join(directory, "fake-cgroup"),
        });
        try {
            await expect(compute.services!.start(ctx, start)).rejects.toThrow(
                /cgroup|Linux namespace/u,
            );
            expect(compute.shell.activeSessionCount?.()).toBe(0);
            await expect(
                readFile(join(start.execution.directory, "policy.json")),
            ).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await compute.dispose(ctx);
        }
    });
    it("refuses read-only starts without elevating or launching a shell", async () => {
        const { start, environment } = await fixture();
        const compute = createHostCompute({ ctx, ...environment });
        start.permissions = computePermissions("read_only");
        try {
            await expect(compute.services!.start(ctx, start)).rejects.toThrow(
                /requires Auto or Full access/u,
            );
            expect(compute.shell.activeSessionCount?.()).toBe(0);
        } finally {
            await compute.dispose(ctx);
        }
    });
    it("still attempts ordinary shell cleanup when service teardown is blocked", async () => {
        const { environment } = await fixture();
        const compute = createHostCompute({ ctx, ...environment });
        vi.spyOn(compute.services!, "dispose").mockRejectedValue(new Error("unconfirmed service"));
        const shells = vi.spyOn(compute.shell, "killAllSessions");
        await expect(compute.dispose(ctx)).rejects.toThrow(/fully clean up host compute/u);
        expect(shells).toHaveBeenCalledOnce();
    });
});
