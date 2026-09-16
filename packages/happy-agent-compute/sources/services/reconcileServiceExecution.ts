import { lstat, open, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { createConnection } from "node:net";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    parseSupervisorPolicy,
    type SupervisorServicePolicy,
} from "@slopus/happy-agent-supervisor";
import { computeServiceExecutionSchema, type ComputeServiceExecution } from "../ComputeServices.js";
import { resolveServiceCgroupParent } from "./resolveServiceCgroupParent.js";
import { ServiceTeardownError } from "./ServiceRuntimeErrors.js";
import {
    assertPrivateServiceDirectory,
    assertServiceExecution,
    readServiceControlFile,
    serviceLifetimeSchema,
    servicePathIsMissing,
    type ServiceLifetime,
    type ServiceProcessIdentity,
} from "./serviceControlFiles.js";

const kernelIdentitySchema = Type.Object({
    state: Type.String({ pattern: "^[A-Za-z]$" }),
    startTime: Type.String({ minLength: 1, maxLength: 32, pattern: "^[0-9]+$" }),
});
const closedBridgeSchema = Type.Object({
    code: Type.Union([Type.Literal("ENOENT"), Type.Literal("ECONNREFUSED")]),
});

/** Never signals a PID or reruns a command. Ambiguous evidence preserves every execution file. */
export async function reconcileServiceExecution(
    execution: ComputeServiceExecution,
    knownSupervisorExit = false,
): Promise<void> {
    if (!Value.Check(computeServiceExecutionSchema, execution)) throw new ServiceTeardownError();
    try {
        await lstat(execution.directory);
    } catch (error) {
        if (servicePathIsMissing(error)) return;
        throw error;
    }
    await assertServiceExecution(execution);
    await assertPrivateServiceDirectory(execution.directory);
    let service: SupervisorServicePolicy;
    let lifetime: ServiceLifetime | undefined;
    try {
        const policy = parseSupervisorPolicy(
            JSON.parse(
                await readServiceControlFile(join(execution.directory, "policy.json"), 1048576),
            ),
        );
        if (policy.service === undefined) throw new ServiceTeardownError();
        service = policy.service;
        try {
            const record: unknown = JSON.parse(
                await readServiceControlFile(join(execution.directory, "process.json"), 16384),
            );
            if (!Value.Check(serviceLifetimeSchema, record)) throw new ServiceTeardownError();
            lifetime = record;
        } catch (error) {
            if (!knownSupervisorExit || !servicePathIsMissing(error)) throw error;
        }
    } catch {
        throw new ServiceTeardownError(
            "Service startup records are missing or incomplete. Preserve the workspace until cleanup can be confirmed.",
        );
    }
    if (
        service.executionId !== execution.id ||
        service.root !== join(execution.directory, "root") ||
        service.bridgeSocket !== join(execution.directory, "bridge") ||
        (!knownSupervisorExit && lifetime?.executionReady !== true)
    ) {
        throw new ServiceTeardownError(
            "Service startup records do not establish a complete execution. Its files were retained.",
        );
    }
    const parent = await resolveServiceCgroupParent(service.cgroupParent);
    const cgroup = join(parent, `happy-service-${execution.id}`);
    const owners = lifetime === undefined ? [] : [lifetime, ...lifetime.children];
    if (lifetime?.executionReady === true && lifetime.children.length < 1)
        throw new ServiceTeardownError();
    const deadline = Date.now() + 10000;
    for (;;) {
        const ownersGone = (await Promise.all(owners.map(nativeOwnerGone))).every(Boolean);
        if (ownersGone && (await cgroupEmpty(cgroup)) && (await bridgeClosed(service.bridgeSocket)))
            break;
        if (Date.now() >= deadline) throw new ServiceTeardownError();
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    // rmdir never removes a populated cgroup. The exact execution directory holds no user inputs.
    try {
        await rmdir(cgroup);
    } catch (error) {
        if (!servicePathIsMissing(error)) throw error;
    }
    await assertPrivateServiceDirectory(execution.directory);
    await rm(execution.directory, { recursive: true });
}

async function nativeOwnerGone(identity: ServiceProcessIdentity): Promise<boolean> {
    let stat: string;
    try {
        stat = await readKernelFile(`/proc/${String(identity.pid)}/stat`);
    } catch (error) {
        if (servicePathIsMissing(error)) return true;
        throw new ServiceTeardownError();
    }
    const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/u);
    const current = { state: fields[0], startTime: fields[19] };
    if (!Value.Check(kernelIdentitySchema, current)) throw new ServiceTeardownError();
    // A zombie has released files, namespaces, and sockets; only its reapable identity remains.
    return (
        current.startTime !== identity.startTime || current.state === "Z" || current.state === "X"
    );
}

async function cgroupEmpty(directory: string): Promise<boolean> {
    try {
        const events = await readKernelFile(join(directory, "cgroup.events"));
        return events.split("\n").some((line) => line.trim() === "populated 0");
    } catch (error) {
        if (servicePathIsMissing(error)) return true;
        throw new ServiceTeardownError();
    }
}

async function readKernelFile(path: string): Promise<string> {
    const file = await open(path, "r");
    try {
        const buffer = Buffer.alloc(16385);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 16384) throw new ServiceTeardownError();
        return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
        await file.close();
    }
}

function bridgeClosed(path: string): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ path });
        const timer = setTimeout(() => finish(false), 250);
        let settled = false;
        const finish = (closed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(closed);
        };
        socket.once("connect", () => finish(false));
        socket.once("error", (error) => finish(Value.Check(closedBridgeSchema, error)));
    });
}
