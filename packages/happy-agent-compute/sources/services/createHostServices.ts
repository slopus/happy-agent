import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "node:net";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { asyncLock, detach, type Context } from "@steve.kite/stdlib";
import { parseSupervisorPolicy, resolveSupervisorBinary } from "@slopus/happy-agent-supervisor";
import { assertComputePermissions, computePermissionsSchema } from "../ComputePermissions.js";
import {
    computeServiceStartSchema,
    type ComputeService,
    type ComputeServiceExit,
    type ComputeServices,
    type ComputeServiceStartOptions,
} from "../ComputeServices.js";
import type { ManagedProcess, NativeProcessManager } from "../processes/NativeProcessManager.js";
import { assertServiceExecution, writeServiceControlFile } from "./serviceControlFiles.js";
import { resolveServiceCgroupParent } from "./resolveServiceCgroupParent.js";
import { resolveServiceInputs, type ServiceInputEnvironment } from "./resolveServiceInputs.js";
import { resolveServiceOutbound } from "./resolveServiceOutbound.js";
import { connectServiceBridge } from "./connectServiceBridge.js";
import { reconcileServiceExecution } from "./reconcileServiceExecution.js";
import { ServiceEndpointUnavailableError, ServiceTeardownError } from "./ServiceRuntimeErrors.js";
import { observeServiceAdmission } from "./observeServiceAdmission.js";

export interface HostServicesOptions extends ServiceInputEnvironment {
    ctx: Context;
    processManager: NativeProcessManager;
    /** Existing administrator delegation; omission discovers the daemon's parent cgroup. */
    cgroupParent?: string;
}

const positionSchema = Type.Object(
    {
        stdout: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        stderr: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
);

/** Separate service sessions sharing only the shell's underlying process I/O machinery. */
export function createHostServices(options: HostServicesOptions): ComputeServices {
    const active = new Map<ComputeService, ManagedProcess>();
    const starts = new Set<Promise<ComputeService>>();
    let closed = false;
    let disposal: Promise<void> | undefined;

    const launch = async (
        ctx: Context,
        supplied: ComputeServiceStartOptions,
    ): Promise<ComputeService> => {
        const start = Value.Parse(computeServiceStartSchema, supplied);
        assertComputePermissions(start.permissions);
        if (start.permissions.mode !== "auto" && start.permissions.mode !== "full_access") {
            throw new Error(
                "Starting a workspace service requires Auto or Full access. Its mandatory service sandbox stays enabled in either mode.",
            );
        }
        const cgroupParent = await resolveServiceCgroupParent(options.cgroupParent);
        const inputs = await resolveServiceInputs(options, start);
        const outbound = resolveServiceOutbound(start);
        await assertServiceExecution(start.execution);
        const binary = resolveSupervisorBinary();
        const directory = start.execution.directory;
        const bridge = join(directory, "bridge");
        const token = randomBytes(32).toString("hex");
        const policy = parseSupervisorPolicy({
            mode: "read_only",
            network: {
                egress: outbound.length > 0,
                localBinding: true,
                ...(outbound.length === 0
                    ? {}
                    : { outgoingProxy: { frontEnds: ["http", "socks5"] } }),
            },
            service: {
                root: join(directory, "root"),
                cwd: start.cwd,
                inputs,
                scratch: start.sandbox.scratch,
                cgroupParent,
                executionId: start.execution.id,
                controllerPid: process.pid,
                bridgeSocket: bridge,
                bridgeToken: token,
                port: start.port,
                memoryMiB: start.sandbox.limits.memoryMiB,
                processes: start.sandbox.limits.processes,
                outbound,
            },
        });
        let created = false;
        let attemptedSpawn = false;
        try {
            await mkdir(directory, { mode: 0o700 });
            created = true;
            await mkdir(join(directory, "root"), { mode: 0o700 });
            await writeServiceControlFile(join(directory, "policy.json"), JSON.stringify(policy));
            if (closed)
                throw new Error("This compute is shutting down and cannot start another service.");
            const processContext = detach(options.ctx).named("workspace-service-process");
            attemptedSpawn = true;
            const managed = await options.processManager.start(ctx, {
                command: binary,
                args: [
                    "--policy-file",
                    join(directory, "policy.json"),
                    "--",
                    "/bin/sh",
                    "-c",
                    start.command,
                ],
                cwd: options.cwd,
                env: {},
                tty: start.tty,
                maxOutputBytes: 1048576,
            });
            const service = session(options, processContext, start, managed, bridge, token);
            active.set(service, managed);
            void service.completion.then(
                () => active.delete(service),
                () => undefined,
            );
            if (closed) {
                await service.stop(ctx);
                throw new Error("The service was stopped because its compute is shutting down.");
            }
            return service;
        } catch (error) {
            // Once spawning was attempted, only the native teardown proof may remove controls.
            if (created && !attemptedSpawn) await rm(directory, { recursive: true });
            throw error;
        }
    };

    return {
        async start(ctx, start) {
            if (closed)
                throw new Error("This compute is shutting down and cannot start another service.");
            if (active.size + starts.size >= 32)
                throw new Error("This compute already has the maximum number of services.");
            const operation = launch(ctx, start);
            starts.add(operation);
            try {
                return await operation;
            } finally {
                starts.delete(operation);
            }
        },
        async reconcile(ctx, execution) {
            await ctx.span("compute.service.reconcile", () => reconcileServiceExecution(execution));
            for (const [service, managed] of active) {
                if (
                    service.execution.id === execution.id &&
                    service.execution.directory === execution.directory
                ) {
                    await managed.wait(ctx);
                    options.processManager.releaseConfirmedProcessGroup(managed);
                    active.delete(service);
                }
            }
        },
        dispose(ctx) {
            closed = true;
            disposal ??= ctx
                .span("compute.services.dispose", async () => {
                    await Promise.allSettled([...starts]);
                    await Promise.all([...active.keys()].map((service) => service.stop(ctx)));
                })
                .catch((error: unknown) => {
                    // Admission stays closed. A later exact-execution reconciliation may establish
                    // cleanup that failed earlier, so disposal must be able to observe that new proof.
                    disposal = undefined;
                    throw error;
                });
            return disposal;
        },
    };
}

function session(
    options: HostServicesOptions,
    processContext: Context,
    start: ComputeServiceStartOptions,
    managed: ManagedProcess,
    bridge: string,
    token: string,
): ComputeService {
    const connections = new Set<Socket>();
    const inputLock = asyncLock();
    let accepting = true;
    let credential = token;
    let stopping: Promise<ComputeServiceExit> | undefined;
    const revoke = () => {
        accepting = false;
        credential = "";
        for (const connection of connections) connection.destroy();
    };
    const exited = managed.wait(processContext);
    const admission = observeServiceAdmission(start.execution.directory, exited);
    const completion = exited.then(async (result) => {
        revoke();
        const admitted = await admission.finalAdmission;
        await admission.admitted;
        await reconcileServiceExecution(start.execution, true);
        options.processManager.releaseConfirmedProcessGroup(managed);
        return { exitCode: result.exitCode, killed: result.killed, startupFailed: !admitted };
    });
    // The owning module observes this promise; cleanup failures may precede that subscription.
    void completion.catch(() => undefined);
    return {
        execution: structuredClone(start.execution),
        processId: managed.id,
        admitted: admission.admitted,
        completion,
        read(position) {
            if (!Value.Check(positionSchema, position))
                throw new Error("Invalid service output position.");
            const output = managed.readOutputDelta(position.stdout, position.stderr, false, true);
            return {
                stdout: output.stdoutDelta,
                stderr: output.stderrDelta,
                position: { stdout: output.stdoutOffset, stderr: output.stderrOffset },
                truncated: output.stdoutDeltaOmittedBytes > 0 || output.stderrDeltaOmittedBytes > 0,
            };
        },
        async write(ctx, permissions, chars) {
            if (
                !Value.Check(computePermissionsSchema, permissions) ||
                (permissions.mode !== "auto" && permissions.mode !== "full_access")
            ) {
                throw new Error(
                    "Sending service input requires Auto or Full access and never widens its existing sandbox.",
                );
            }
            assertComputePermissions(permissions);
            if (Buffer.byteLength(chars, "utf8") > 65536)
                throw new Error("Service input exceeds 64 KiB.");
            return inputLock.runInLock(ctx, async () =>
                accepting ? managed.writeStdin(ctx, chars) : false,
            );
        },
        async connect(ctx) {
            if (!accepting)
                throw new ServiceEndpointUnavailableError(
                    "The service has stopped accepting connections.",
                );
            return ctx.span("compute.service.connect", async () => {
                const socket = await connectServiceBridge(bridge, credential, connections);
                if (!accepting || socket.destroyed) {
                    socket.destroy();
                    throw new ServiceEndpointUnavailableError();
                }
                return socket;
            });
        },
        stop(ctx) {
            revoke();
            stopping ??= managed
                .kill(processContext, "SIGTERM", { forceAfterMs: 2000 })
                .then(() => completion);
            void stopping.catch(() => undefined);
            return ctx.span("compute.service.stop", () => boundedStop(stopping!));
        },
    };
}

async function boundedStop(completion: Promise<ComputeServiceExit>): Promise<ComputeServiceExit> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            completion,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new ServiceTeardownError()), 12000);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}
