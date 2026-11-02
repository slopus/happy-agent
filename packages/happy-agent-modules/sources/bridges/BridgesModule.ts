import { isDeepStrictEqual } from "node:util";

import { createId } from "@paralleldrive/cuid2";
import type { AgentModule } from "@slopus/happy-agent-base";
import {
    WORKSPACE_BRIDGE_CLOSE_CODES,
    type WorkspaceBridge,
    type WorkspaceBridgeCapabilities,
    type WorkspaceBridgeCapability,
    type WorkspaceBridgeReason,
    type WorkspacePortBridgeListener,
    type WorkspaceUsbBridgeDevice,
} from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";
import { detach, forever, isAbortedError, withLifetime, type Context } from "@steve.kite/stdlib";

import { BotsModule } from "../bots/index.js";
import { createUuidV7Factory } from "../events/index.js";
import { ProjectsModule } from "../projects/index.js";
import { RunnersModule } from "../runners/index.js";
import type { SurfacesModule } from "../surfaces/index.js";
import type { TasksModule } from "../tasks/index.js";
import { WorkspacesModule } from "../workspaces/index.js";

import {
    BridgeError,
    bridgeEventListenerSchema,
    MAX_PORT_BRIDGES,
    MAX_PORT_BRIDGES_PER_WORKSPACE,
    MAX_USB_BRIDGES,
    portBridgeRequestSchema,
    usbBridgeRequestSchema,
    type BridgeAdmission,
    type BridgeEnding,
    type BridgeEvent,
    type BridgeEventListener,
    type PortBridgeRequest,
    type UsbBridgeRequest,
} from "./Bridge.js";
import { PortBridgeSession } from "./impl/PortBridgeSession.js";
import type { UsbMachineProbe } from "./impl/probeUsbMachine.js";
import { UsbBridgeSession } from "./impl/UsbBridgeSession.js";
import { createUsbHostController, type UsbHostController } from "./impl/UsbHostController.js";

/** How often the machine is probed again for a change in what it can bridge. */
const PROBE_INTERVAL_MS = 60_000;

/** Where a workspace's folder runs, which decides what it can bridge. */
type BridgeCompute = "host" | "docker" | "runner";

interface BridgeWorkspace {
    readonly workspaceId: string;
    readonly compute: BridgeCompute;
    /** The runner holding the folder, when it is on one. */
    readonly runnerId?: string;
    /** The workspace and the project, bot, or task it belongs to: archiving any ends its bridges. */
    readonly keys: readonly string[];
}

/** One bridge from admission until it ends. */
interface BridgeEntry {
    readonly id: string;
    readonly kind: "usb" | "port";
    readonly ownerId: string;
    readonly workspaceId: string;
    readonly runnerId: string | undefined;
    readonly keys: readonly string[];
    readonly name: string | undefined;
    readonly session: UsbBridgeSession | PortBridgeSession;
    /** Present once the bridge is established. */
    resource: WorkspaceBridge | undefined;
    /** The `DELETE` that is ending the bridge, echoed on its closing event. */
    mutationId: string | undefined;
}

const CLOSED_BY_REQUEST: BridgeEnding = {
    reason: "closed_by_request",
    code: WORKSPACE_BRIDGE_CLOSE_CODES.normal,
    message: "The bridge was closed on request.",
};
const WORKSPACE_ARCHIVED: BridgeEnding = {
    reason: "workspace_archived",
    code: WORKSPACE_BRIDGE_CLOSE_CODES.normal,
    message: "The workspace was archived.",
};
const DAEMON_SHUTDOWN: BridgeEnding = {
    reason: "daemon_shutdown",
    code: WORKSPACE_BRIDGE_CLOSE_CODES.shutdown,
    message: "Happy Agent is shutting down.",
};
const UPGRADE_FAILED: BridgeEnding = {
    reason: "failed",
    code: WORKSPACE_BRIDGE_CLOSE_CODES.internal,
    message: "The bridge's WebSocket could not be opened.",
};

/**
 * Local bridges: a USB device, a Bluetooth adapter, or a local TCP service on a person's own
 * computer, reaching the machine one of their workspaces runs on.
 *
 * A bridge belongs to the client WebSocket that opened it and lives exactly as long as that
 * WebSocket. The module never opens one on its own, for an agent, or for anyone but the
 * authenticated person whose WebSocket it is, and nothing about a bridge is stored: a restart
 * leaves none behind.
 */
export class BridgesModule implements AgentModule {
    readonly name = "bridges";

    readonly #projects: ProjectsModule;
    readonly #workspaces: WorkspacesModule;
    readonly #runners: RunnersModule;
    readonly #bots: BotsModule | undefined;
    readonly #tasks: TasksModule | undefined;
    readonly #surfaces: SurfacesModule | undefined;
    readonly #listeners = new Set<BridgeEventListener>();
    readonly #nextVersion = createUuidV7Factory();
    /** Every bridge from admission to its end, established or not, keyed by ID. */
    readonly #bridges = new Map<string, BridgeEntry>();
    readonly #stopProbing = new AbortController();
    #controller: UsbHostController = createUsbHostController();
    #machine: UsbMachineProbe | undefined;
    #probing: Promise<UsbMachineProbe> | undefined;
    #probeLoop: Promise<void> | undefined;
    /**
     * Counts archivals. An admission that saw it change while resolving its workspace resolves
     * again, so an archival can never slip between the check and the bridge it would have ended.
     */
    #archivals = 0;
    #closed = false;

    /**
     * @param projects The catalog of projects, whose root folders are workspaces too.
     * @param workspaces The catalog of managed workspaces: whether one is ready, and where it runs.
     * @param runners The owner of the machines folders live on. A USB bridge reaches the daemon's
     * own kernel only, which runners may have ruled out; a port bridge listens on the folder's
     * machine, wherever it is.
     */
    constructor(
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        runners: RunnersModule,
        bots?: BotsModule,
        tasks?: TasksModule,
        surfaces?: SurfacesModule,
    ) {
        this.#projects = projects;
        this.#workspaces = workspaces;
        this.#runners = runners;
        this.#bots = bots;
        this.#tasks = tasks;
        this.#surfaces = surfaces;

        // Archiving is the decision that a folder is nobody's any more. Its bridges end with it,
        // and the catalogs that own the decision never need to know bridges exist.
        workspaces.onEvent((_ctx, event) => {
            if (event.type !== "workspace_updated" || event.change !== "begin_archive") return;
            this.#closeKey(event.workspace.id);
        });
        projects.onEvent((_ctx, event) => {
            if (event.type !== "project_archived") return;
            this.#closeKey(event.project.id);
        });
        bots?.onEvent((_ctx, event) => {
            if (
                event.type !== "bot_updated" ||
                event.bot.status !== "archived" ||
                event.previousBot.status === "archived"
            )
                return;
            this.#closeKey(event.bot.workspaceId);
        });
        tasks?.onEvent((_ctx, event) => {
            if (
                event.type !== "task_updated" ||
                event.task.status !== "archived" ||
                event.previousTask.status === "archived"
            )
                return;
            this.#closeKey(event.task.workspaceId);
        });
    }

    /**
     * Test-only construction over a stand-in for the kernel's USB/IP controller.
     *
     * Production always uses the real controller under `/sys`. A test that needs a device to
     * attach replaces that boundary here instead of reaching into the module.
     */
    static withUsbHostController(
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        runners: RunnersModule,
        controller: UsbHostController,
        bots?: BotsModule,
        tasks?: TasksModule,
    ): BridgesModule {
        const module = new BridgesModule(projects, workspaces, runners, bots, tasks);
        module.#controller = controller;
        return module;
    }

    readonly beforeStart = (ctx: Context): void => {
        if (this.#probeLoop !== undefined || this.#closed) return;
        const signal =
            ctx.lifetime === undefined
                ? this.#stopProbing.signal
                : AbortSignal.any([ctx.lifetime, this.#stopProbing.signal]);
        const probeCtx = withLifetime(detach(ctx).named("bridge-capabilities"), signal);
        this.#probeLoop = forever(
            probeCtx,
            { delay: PROBE_INTERVAL_MS, delayFirst: false, name: "bridge-capabilities" },
            async () => {
                await this.#probe();
            },
        ).catch((error: unknown) => {
            if (!isAbortedError(error)) {
                ctx.log.warn("Bridge capability probing stopped.", {}, error);
            }
        });
    };

    /** Takes a listener for every bridge change in this daemon lifetime. */
    onEvent(listener: BridgeEventListener): () => void {
        if (!Value.Check(bridgeEventListenerSchema, listener)) {
            throw new Error("A bridge subscriber must be a function.");
        }
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** What one workspace can bridge, and the bridges its caller has open on it. */
    async list(
        ctx: Context,
        ownerId: string,
        workspaceId: string,
    ): Promise<{
        readonly capabilities: WorkspaceBridgeCapabilities;
        readonly bridges: WorkspaceBridge[];
    }> {
        const workspace = await this.#workspace(ctx, workspaceId);
        const capabilities = capabilitiesFor(workspace.compute, await this.#probe());
        const bridges = [...this.#bridges.values()]
            .filter(
                (entry) =>
                    entry.ownerId === ownerId &&
                    entry.workspaceId === workspaceId &&
                    entry.resource?.status === "open",
            )
            .map((entry) => structuredClone(entry.resource!))
            .sort((left, right) => left.createdAt - right.createdAt);
        return { capabilities, bridges };
    }

    /**
     * Admits one USB bridge before its WebSocket upgrade.
     *
     * Everything that can be refused with a status is refused here: the workspace, the machine's
     * USB support, the ID, and the limit. The import itself happens over the WebSocket.
     */
    async admitUsb(
        ctx: Context,
        ownerId: string,
        workspaceId: string,
        request: UsbBridgeRequest,
    ): Promise<BridgeAdmission> {
        if (!Value.Check(usbBridgeRequestSchema, request)) {
            throw new BridgeError("invalid_request", "The USB bridge request is invalid.");
        }
        const machine = await this.#probe();
        const entry = await this.#admit(ctx, workspaceId, (workspace) => {
            const usb = capabilitiesFor(workspace.compute, machine).usb;
            if (!usb.available) throw unavailable(usb);
            this.#runners.assertLocalExecution();
            const open = [...this.#bridges.values()].filter((other) => other.kind === "usb");
            if (open.length >= MAX_USB_BRIDGES) {
                throw new BridgeError(
                    "bridge_limit",
                    `At most ${String(MAX_USB_BRIDGES)} USB devices can be bridged at once.`,
                );
            }
            const id = this.#newId(request.id);
            const bridgeCtx = detach(ctx).named("workspace-usb-bridge");
            const created: BridgeEntry = {
                id,
                kind: "usb",
                ownerId,
                workspaceId,
                runnerId: workspace.runnerId,
                keys: workspace.keys,
                name: request.name,
                mutationId: undefined,
                resource: undefined,
                session: new UsbBridgeSession({
                    busId: request.busId,
                    controller: this.#controller,
                    ctx: bridgeCtx,
                    opened: (device) => {
                        this.#opened(created, device, null);
                    },
                    ended: (ending) => {
                        this.#ended(created, ending);
                    },
                }),
            };
            return created;
        });
        return this.#admission(entry);
    }

    /**
     * Admits one port bridge before its WebSocket upgrade, binding its listener.
     *
     * The listener is bound here rather than after the upgrade so a port in use is an ordinary
     * refusal the client can show, not a WebSocket that opens and closes again.
     */
    async admitPort(
        ctx: Context,
        ownerId: string,
        workspaceId: string,
        request: PortBridgeRequest,
    ): Promise<BridgeAdmission> {
        if (!Value.Check(portBridgeRequestSchema, request)) {
            throw new BridgeError("invalid_request", "The port bridge request is invalid.");
        }
        const machine = await this.#probe();
        const entry = await this.#admit(ctx, workspaceId, (workspace) => {
            const reach = capabilitiesFor(workspace.compute, machine).workspaceToLocal;
            if (!reach.available) throw unavailable(reach);
            const ports = [...this.#bridges.values()].filter((other) => other.kind === "port");
            if (
                ports.length >= MAX_PORT_BRIDGES ||
                ports.filter((other) => other.workspaceId === workspaceId).length >=
                    MAX_PORT_BRIDGES_PER_WORKSPACE
            ) {
                throw new BridgeError(
                    "bridge_limit",
                    `At most ${String(MAX_PORT_BRIDGES_PER_WORKSPACE)} ports can be forwarded from one workspace, and ${String(MAX_PORT_BRIDGES)} from this machine.`,
                );
            }
            const id = this.#newId(request.id);
            const bridgeCtx = detach(ctx).named("workspace-port-bridge");
            const created: BridgeEntry = {
                id,
                kind: "port",
                ownerId,
                workspaceId,
                runnerId: workspace.runnerId,
                keys: workspace.keys,
                name: request.name,
                mutationId: undefined,
                resource: undefined,
                session: new PortBridgeSession({
                    ctx: bridgeCtx,
                    opened: (listener) => this.#opened(created, null, listener),
                    ended: (ending) => {
                        this.#ended(created, ending);
                    },
                }),
            };
            return created;
        });
        const session = entry.session as PortBridgeSession;
        try {
            await session.listen(await this.#runners.machine(entry.runnerId), request.port);
        } catch (error) {
            const ending = session.ending;
            if (ending !== undefined) throw endedBeforeOpening(ending);
            session.end(UPGRADE_FAILED);
            throw error;
        }
        const ending = session.ending;
        if (ending !== undefined) throw endedBeforeOpening(ending);
        return this.#admission(entry);
    }

    /**
     * Claims one waiting connection of a port bridge for the WebSocket that will carry it.
     *
     * Only the bridge's owner may, and only once: a connection someone else's bridge holds, one
     * already claimed, and one that has gone are all simply not found.
     */
    admitConnection(
        ownerId: string,
        workspaceId: string,
        bridgeId: string,
        connectionId: string,
    ): BridgeAdmission {
        const entry = this.#bridges.get(bridgeId);
        const admission =
            entry !== undefined &&
            entry.ownerId === ownerId &&
            entry.workspaceId === workspaceId &&
            entry.resource?.status === "open" &&
            entry.session instanceof PortBridgeSession
                ? entry.session.accept(connectionId)
                : undefined;
        if (admission === undefined) {
            throw new BridgeError("not_found", "The connection was not found.");
        }
        return admission;
    }

    /** Ends one open bridge on its owner's request, and returns its closed record. */
    closeBridge(
        ownerId: string,
        workspaceId: string,
        bridgeId: string,
        mutationId?: string,
    ): WorkspaceBridge {
        const entry = this.#bridges.get(bridgeId);
        if (
            entry === undefined ||
            entry.ownerId !== ownerId ||
            entry.workspaceId !== workspaceId ||
            entry.resource?.status !== "open"
        ) {
            throw new BridgeError("not_found", "The bridge was not found.");
        }
        entry.mutationId = mutationId;
        entry.session.end(CLOSED_BY_REQUEST);
        return structuredClone(entry.resource);
    }

    /** Ends every bridge, and opens nothing more. */
    async close(): Promise<void> {
        this.#closed = true;
        for (const entry of this.#bridges.values()) entry.session.end(DAEMON_SHUTDOWN);
        this.#stopProbing.abort();
        await this.#probeLoop;
    }

    /**
     * Resolves a workspace and registers a new bridge in one step that no archival can split.
     *
     * `register` runs synchronously right after the resolution it was given, and only if no
     * archival happened while that resolution was in flight. From the moment it returns, the
     * bridge is in the table an archival ends bridges from.
     */
    async #admit(
        ctx: Context,
        workspaceId: string,
        register: (workspace: BridgeWorkspace) => BridgeEntry,
    ): Promise<BridgeEntry> {
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const archivals = this.#archivals;
            const workspace = await this.#workspace(ctx, workspaceId);
            if (archivals !== this.#archivals) continue;
            if (this.#closed) {
                throw new BridgeError("unavailable", "Happy Agent is shutting down.");
            }
            const entry = register(workspace);
            this.#bridges.set(entry.id, entry);
            return entry;
        }
        throw new BridgeError("conflict", "The workspace is changing. Try again.");
    }

    #admission(entry: BridgeEntry): BridgeAdmission {
        return {
            attach: (webSocket) => entry.session.attach(webSocket),
            failed: () => {
                entry.session.end(UPGRADE_FAILED);
            },
        };
    }

    #newId(requested: string | undefined): string {
        if (requested === undefined) return createId();
        if (this.#bridges.has(requested)) {
            throw new BridgeError("conflict", "A bridge with this ID is already open.");
        }
        return requested;
    }

    /** The bridge is established: record it and announce it to its owner. */
    #opened(
        entry: BridgeEntry,
        usb: WorkspaceUsbBridgeDevice | null,
        port: WorkspacePortBridgeListener | null,
    ): WorkspaceBridge {
        const now = Date.now();
        const resource: WorkspaceBridge = {
            id: entry.id,
            workspaceId: entry.workspaceId,
            kind: entry.kind,
            name:
                entry.name ??
                (usb !== null
                    ? `USB device ${usb.vendorId}:${usb.productId}`
                    : `Port ${String(port?.port ?? 0)}`),
            status: "open",
            usb,
            port,
            closeReason: null,
            version: this.#nextVersion(),
            createdAt: now,
            updatedAt: now,
            closedAt: null,
        };
        entry.resource = resource;
        this.#emit({
            type: "bridge.created",
            ownerId: entry.ownerId,
            payload: { bridge: structuredClone(resource) },
        });
        return structuredClone(resource);
    }

    /** The bridge ended. An established one is recorded closed and announced. */
    #ended(entry: BridgeEntry, ending: BridgeEnding): void {
        if (this.#bridges.get(entry.id) === entry) this.#bridges.delete(entry.id);
        const before = entry.resource;
        if (before?.status !== "open") return;
        const now = Date.now();
        const closeReason = { code: ending.reason, message: ending.message };
        const after: WorkspaceBridge = {
            ...before,
            status: "closed",
            closeReason,
            closedAt: now,
            updatedAt: now,
            version: this.#nextVersion(),
        };
        entry.resource = after;
        this.#emit({
            type: "bridge.updated",
            ownerId: entry.ownerId,
            payload: {
                bridgeId: entry.id,
                workspaceId: entry.workspaceId,
                previousVersion: before.version,
                version: after.version,
                changes: { status: "closed", closeReason, closedAt: now, updatedAt: now },
                ...(entry.mutationId === undefined ? {} : { mutationId: entry.mutationId }),
            },
        });
    }

    /** Ends every bridge, admitted or open, whose workspace belongs to `key`. */
    #closeKey(key: string): void {
        this.#archivals += 1;
        for (const entry of this.#bridges.values()) {
            if (entry.keys.includes(key)) entry.session.end(WORKSPACE_ARCHIVED);
        }
    }

    /**
     * Probes the machine, sharing a probe already in flight, and announces a changed answer.
     *
     * Every admission probes afresh rather than trusting the last minute's answer: a module
     * loaded or a permission granted a moment ago should work at once.
     */
    async #probe(): Promise<UsbMachineProbe> {
        this.#probing ??= this.#controller
            .probe()
            .then((machine) => {
                const previous = this.#machine;
                this.#machine = machine;
                if (previous !== undefined && !isDeepStrictEqual(previous, machine)) {
                    this.#emit({ type: "bridges.capabilities.updated", payload: {} });
                }
                return machine;
            })
            .finally(() => {
                this.#probing = undefined;
            });
        return await this.#probing;
    }

    #emit(event: BridgeEvent): void {
        for (const listener of this.#listeners) {
            try {
                listener(structuredClone(event));
            } catch {
                // The bridge has already changed. An observer must not make it look as if it had
                // not.
            }
        }
    }

    /** Where a workspace runs, refused as the other workspace routes refuse it. */
    async #workspace(ctx: Context, workspaceId: string): Promise<BridgeWorkspace> {
        const bot = await this.#bots?.forWorkspace(ctx, workspaceId);
        if (bot !== undefined) {
            if (bot.status !== "active") throw notAvailable();
            return {
                workspaceId,
                ...placed(bot.runnerId),
                keys: [workspaceId, bot.id],
            };
        }
        const task = await this.#tasks?.forWorkspace(ctx, workspaceId);
        if (task !== undefined) {
            if (task.status !== "active") throw notAvailable();
            return {
                workspaceId,
                ...placed(task.runnerId),
                keys: [workspaceId, task.id],
            };
        }
        const chat = await this.#surfaces?.chatForWorkspace(ctx, workspaceId);
        if (chat !== undefined)
            return {
                workspaceId,
                ...placed(chat.runnerId),
                keys: [workspaceId, chat.surfaceId],
            };
        const project = await this.#projects.get(ctx, workspaceId);
        if (project !== undefined) {
            if (project.status !== "active") throw notAvailable();
            const compute = this.#projects.compute(project);
            return {
                workspaceId,
                ...placed(compute.type === "runner" ? compute.runnerId : undefined),
                keys: [project.id],
            };
        }
        const workspace = await this.#workspaces.get(ctx, workspaceId);
        if (workspace === undefined) {
            throw new BridgeError("not_found", "The workspace was not found.");
        }
        if (workspace.status === "initializing") {
            throw new BridgeError("not_initialized", "The workspace is still initializing.");
        }
        if (workspace.status !== "ready") throw notAvailable();
        return {
            workspaceId,
            ...(workspace.dockerImage !== undefined
                ? { compute: "docker" as const }
                : placed(workspace.runnerId)),
            keys: [workspaceId, workspace.projectRef],
        };
    }
}

/** Where a folder held by `runnerId`, or by this machine, runs. */
function placed(runnerId: string | undefined): Pick<BridgeWorkspace, "compute" | "runnerId"> {
    return runnerId === undefined ? { compute: "host" } : { compute: "runner", runnerId };
}

/** What a workspace that runs in `compute` can bridge, on a machine that answered `machine`. */
function capabilitiesFor(
    compute: BridgeCompute,
    machine: UsbMachineProbe,
): WorkspaceBridgeCapabilities {
    if (compute === "docker") {
        const container = unavailableCapability({
            code: "container_compute",
            message:
                "This workspace runs in a Docker container, which has neither its host's devices nor its loopback network.",
        });
        return {
            usb: container,
            bluetooth: { ...container, transport: "usb" },
            localToWorkspace: container,
            workspaceToLocal: container,
        };
    }
    if (compute === "runner") {
        // Permanent: a client hides USB and Bluetooth for a workspace that reports this code.
        const runner = unavailableCapability({
            code: "runner_compute",
            message: "USB and Bluetooth are not supported on runners.",
        });
        return {
            usb: runner,
            bluetooth: { ...runner, transport: "usb" },
            localToWorkspace: { available: true, reason: null },
            workspaceToLocal: { available: true, reason: null },
        };
    }
    return {
        usb:
            machine.usb === null
                ? { available: true, reason: null }
                : unavailableCapability(machine.usb),
        bluetooth:
            machine.bluetooth === null
                ? { available: true, transport: "usb", reason: null }
                : { ...unavailableCapability(machine.bluetooth), transport: "usb" },
        localToWorkspace: { available: true, reason: null },
        workspaceToLocal: { available: true, reason: null },
    };
}

function unavailableCapability(reason: WorkspaceBridgeReason): WorkspaceBridgeCapability {
    return { available: false, reason };
}

function unavailable(capability: WorkspaceBridgeCapability): BridgeError {
    const reason = capability.reason ?? {
        code: "unavailable",
        message: "This workspace cannot open that bridge.",
    };
    return new BridgeError("bridge_unavailable", reason.message, reason);
}

function notAvailable(): BridgeError {
    return new BridgeError("conflict", "The workspace is not available.");
}

/** The refusal for an admission whose bridge ended before its WebSocket opened. */
function endedBeforeOpening(ending: BridgeEnding): BridgeError {
    if (ending.reason === "daemon_shutdown") {
        return new BridgeError("unavailable", "Happy Agent is shutting down.");
    }
    if (ending.reason === "workspace_archived") return notAvailable();
    return new BridgeError("conflict", ending.message);
}
