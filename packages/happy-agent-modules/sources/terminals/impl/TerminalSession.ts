import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

import {
    createGhosttyRemoteTerminalServer,
    ghosttySnapshotToGrid,
    type GhosttyRemoteTerminalServerDriver,
    type RemoteTerminalAttachOptions,
    type RemoteTerminalProtocolMetrics,
    type RemoteTerminalProtocolServer,
    type RemoteTerminalScrollbackPage,
} from "@slopus/ghostty-web";
import { createId } from "@paralleldrive/cuid2";

import {
    MAX_TERMINAL_COLS,
    MAX_TERMINAL_ROWS,
    TerminalError,
    type Terminal,
    type TerminalColorScheme,
} from "../Terminal.js";
import type { TerminalProcess, TerminalProcessFactory } from "../TerminalProcess.js";
import { GhosttyTerminalState } from "./GhosttyTerminalState.js";

/** How long a killed terminal process has to be reaped before stopping gives up out loud. */
const TERMINAL_EXIT_TIMEOUT_MS = 2_000;

/**
 * One live terminal: a process, the canonical emulator it writes into, and the protocol that keeps
 * every attached replica in step with that emulator.
 *
 * Output goes straight from the process into the emulator and out to whoever is watching. Nothing
 * is coalesced on a timer and no screen is ever diffed: the ordered bytes are the delta, and the
 * same emulator on the other side is what turns them back into a picture.
 */
export class TerminalSession {
    readonly id = createId();
    readonly colorScheme: TerminalColorScheme;

    readonly #driver: GhosttyRemoteTerminalServerDriver;
    #exitCode: number | null = null;
    readonly #exited: Promise<void>;
    readonly #nextVersion: () => string;
    readonly #onChange: (before: Terminal, after: Terminal) => void;
    readonly #process: TerminalProcess;
    readonly #protocol: RemoteTerminalProtocolServer;
    readonly #state: GhosttyTerminalState;
    #status: "exited" | "running" = "running";
    readonly #unsubscribe: () => void;
    #version: string;
    readonly #workspaceId: string;

    private constructor(options: {
        readonly colorScheme: TerminalColorScheme;
        readonly created: ReturnType<typeof createGhosttyRemoteTerminalServer>;
        readonly nextVersion: () => string;
        readonly onChange: (before: Terminal, after: Terminal) => void;
        readonly process: TerminalProcess;
        readonly state: GhosttyTerminalState;
        readonly workspaceId: string;
    }) {
        this.colorScheme = options.colorScheme;
        this.#state = options.state;
        this.#process = options.process;
        this.#driver = options.created.driver;
        this.#protocol = options.created.protocol;
        this.#onChange = options.onChange;
        this.#nextVersion = options.nextVersion;
        this.#version = options.nextVersion();
        this.#workspaceId = options.workspaceId;
        this.#unsubscribe = options.process.onData((data) => {
            // Output the canonical emulator cannot accept is not something to retry or drop: the
            // screen would silently stop matching. Ending the process is the honest failure.
            void this.#driver.publishOutput(data).catch(() => options.process.kill());
        });
        this.#exited = options.process.wait().then(async ({ exitCode }) => {
            const before = this.terminal();
            this.#exitCode = exitCode;
            this.#status = "exited";
            this.#unsubscribe();
            // Exit is ordered after the last display barrier, so a viewer sees the final screen
            // and only then learns the process is gone.
            await this.#driver.publishExit(exitCode).catch(() => undefined);
            this.#changed(before);
        });
    }

    static async create(options: {
        readonly cols: number;
        readonly colorScheme: TerminalColorScheme;
        readonly cwd: string;
        readonly maxScrollback: number;
        readonly nextVersion: () => string;
        readonly onChange: (before: Terminal, after: Terminal) => void;
        readonly processFactory: TerminalProcessFactory;
        readonly processOptions: Parameters<TerminalProcessFactory["start"]>[0];
        readonly rows: number;
        readonly workspaceId: string;
    }): Promise<TerminalSession> {
        const state = await GhosttyTerminalState.create({
            cols: options.cols,
            colorScheme: options.colorScheme,
            maxScrollback: options.maxScrollback,
            rows: options.rows,
        });
        let process: TerminalProcess | undefined;
        try {
            process = await options.processFactory.start(options.processOptions);
            const started = process;
            const historyEpoch = randomUUID();
            const created = createGhosttyRemoteTerminalServer(state, {
                initialCols: options.cols,
                initialRows: options.rows,
                onFlowControl(paused) {
                    if (paused) started.pause();
                    else started.resume();
                },
                async onInput(data) {
                    if (!(await started.write(data))) {
                        throw new TerminalError("conflict", "The terminal has exited.");
                    }
                },
                onResize(cols, rows) {
                    return started.resize(cols, rows);
                },
                onScrollback(start, count, basis) {
                    return scrollbackPage(state, historyEpoch, start, count, basis);
                },
                async onTerminalResponse(data) {
                    await started.write(data);
                },
            });
            // The first thing an attachment can be given is the screen as it is right now, so a
            // client that arrives late still starts from a complete picture rather than a gap.
            created.protocol.publishGrid({
                ...ghosttySnapshotToGrid(state.snapshot(), options.cols),
                coversOutputOffset: 0,
            });
            return new TerminalSession({
                colorScheme: options.colorScheme,
                created,
                nextVersion: options.nextVersion,
                onChange: options.onChange,
                process,
                state,
                workspaceId: options.workspaceId,
            });
        } catch (error) {
            await process?.kill();
            state.close();
            throw error;
        }
    }

    /**
     * Add one attachment.
     *
     * Snapshot-then-deltas, resize barriers, epoch invalidation and credit-based flow control all
     * belong to the protocol, so every viewer — including one that may never type — arrives here.
     */
    attach(stream: Duplex, options?: RemoteTerminalAttachOptions): () => void {
        return this.#protocol.attach(stream, options);
    }

    async dispose(): Promise<void> {
        // A process that outlives even the kill must not keep a folder, a workspace, or a
        // shutting-down daemon waiting; the emulator and its state still go away here.
        await this.stop().catch(() => undefined);
        this.#driver.close();
        this.#state.close();
    }

    metrics(): Readonly<RemoteTerminalProtocolMetrics> {
        return this.#protocol.metrics;
    }

    /**
     * Resize through the protocol's own canonical operation: drain, resize the process and the
     * canonical emulator together, tell every attachment, and only then release output produced
     * for the new geometry.
     */
    async resize(cols: number, rows: number): Promise<Terminal> {
        assertSize(cols, rows);
        const before = this.terminal();
        if (before.cols === cols && before.rows === rows) return before;
        await this.#protocol.resize(cols, rows);
        this.#changed(before);
        return this.terminal();
    }

    /**
     * Close the terminal at once: the process is killed outright rather than asked to leave, so
     * a shell that would have sat on a hangup cannot hold this request — or, through it, a daemon
     * drain — open. Waiting here is only for the kill to be reaped.
     */
    async stop(): Promise<Terminal> {
        if (this.#status === "running") await this.#process.kill();
        if (!(await this.#exitedWithin(TERMINAL_EXIT_TIMEOUT_MS))) {
            throw new TerminalError(
                "unavailable",
                "The terminal process did not exit after it was killed.",
            );
        }
        return this.terminal();
    }

    /** Whether the kill has been reaped in time, without holding the event loop open. */
    async #exitedWithin(milliseconds: number): Promise<boolean> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                this.#exited.then(() => true),
                new Promise<boolean>((resolve) => {
                    timer = setTimeout(() => resolve(false), milliseconds);
                    timer.unref();
                }),
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    terminal(): Terminal {
        const dimensions = this.#protocol.dimensions();
        return {
            cols: dimensions.cols,
            colorScheme: this.colorScheme,
            epoch: this.#protocol.epoch,
            exitCode: this.#exitCode,
            id: this.id,
            rows: dimensions.rows,
            status: this.#status,
            version: this.#version,
            workspaceId: this.#workspaceId,
        };
    }

    /** Mint one new resource version and notify observers if state actually changed. */
    #changed(before: Terminal): void {
        const current = this.terminal();
        if (sameTerminalState(before, current)) return;
        this.#version = this.#nextVersion();
        this.#onChange(before, this.terminal());
    }
}

function sameTerminalState(left: Terminal, right: Terminal): boolean {
    return (
        left.cols === right.cols &&
        left.colorScheme === right.colorScheme &&
        left.epoch === right.epoch &&
        left.exitCode === right.exitCode &&
        left.id === right.id &&
        left.rows === right.rows &&
        left.status === right.status &&
        left.workspaceId === right.workspaceId
    );
}

/**
 * One page of history, refused when the caller's basis no longer describes what is stored.
 *
 * Scrollback is not a fixed array: output shifts it and retention drops from the top of it. A page
 * built against a basis that has moved would look valid and be wrong, so it is rejected instead.
 */
function scrollbackPage(
    state: GhosttyTerminalState,
    historyEpoch: string,
    start: number,
    count: number,
    basis?: { readonly historyEpoch: string; readonly historyRevision: number },
): RemoteTerminalScrollbackPage {
    const historyRevision = state.historyRevision();
    if (
        basis !== undefined &&
        (basis.historyEpoch !== historyEpoch || basis.historyRevision !== historyRevision)
    ) {
        throw new TerminalError("conflict", "The terminal scrollback basis is stale.");
    }
    const snapshot = state.snapshotPage(start, count);
    const grid = ghosttySnapshotToGrid(snapshot);
    return {
        baseRow: 0,
        count,
        historyEpoch,
        historyRevision,
        palette: grid.palette,
        rows: grid.rows,
        start,
        styles: grid.styles,
        totalRows: snapshot.scroll.totalRows,
    };
}

function assertSize(cols: number, rows: number): void {
    if (!Number.isSafeInteger(cols) || cols < 1 || cols > MAX_TERMINAL_COLS) {
        throw new TerminalError(
            "invalid",
            `The terminal column count must be between 1 and ${MAX_TERMINAL_COLS}.`,
        );
    }
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > MAX_TERMINAL_ROWS) {
        throw new TerminalError(
            "invalid",
            `The terminal row count must be between 1 and ${MAX_TERMINAL_ROWS}.`,
        );
    }
}
