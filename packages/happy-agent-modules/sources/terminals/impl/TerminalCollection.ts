import { isAbsolute, resolve } from "node:path";

import {
    DEFAULT_TERMINAL_COLOR_SCHEME,
    DEFAULT_TERMINAL_COLS,
    DEFAULT_TERMINAL_ROWS,
    DEFAULT_TERMINAL_SCROLLBACK,
    MAX_TERMINALS_PER_SCOPE,
    TerminalError,
    type CreateTerminalInput,
    type Terminal,
} from "../Terminal.js";
import type { TerminalProcessFactory } from "../TerminalProcess.js";
import { TerminalSession } from "./TerminalSession.js";

/**
 * Every terminal open on one folder.
 *
 * The collection is deliberately not durable. A terminal is a running process and a live screen;
 * when the daemon stops, both are gone, and a record saying otherwise would only describe something
 * nobody can attach to.
 */
export class TerminalCollection {
    /** Which project this folder belongs to, so a project closing takes its workspaces with it. */
    readonly projectId: string;

    readonly #nextVersion: () => string;
    readonly #onCreated: (terminal: Terminal) => void;
    readonly #onUpdated: (before: Terminal, after: Terminal) => void;
    readonly #processFactory: TerminalProcessFactory;
    readonly #root: string;
    readonly #sessions = new Map<string, TerminalSession>();
    readonly #workspaceId: string;
    /** Set by `dispose`: this folder is gone, and nothing opens in it again. */
    #disposed = false;

    constructor(options: {
        readonly nextVersion: () => string;
        readonly onCreated: (terminal: Terminal) => void;
        readonly onUpdated: (before: Terminal, after: Terminal) => void;
        readonly processFactory: TerminalProcessFactory;
        readonly projectId: string;
        readonly root: string;
        readonly workspaceId: string;
    }) {
        this.projectId = options.projectId;
        this.#nextVersion = options.nextVersion;
        this.#onCreated = options.onCreated;
        this.#onUpdated = options.onUpdated;
        this.#processFactory = options.processFactory;
        this.#root = options.root;
        this.#workspaceId = options.workspaceId;
    }

    /** Whether this folder's collection has been ended and can never hold a terminal again. */
    get disposed(): boolean {
        return this.#disposed;
    }

    async create(input: CreateTerminalInput): Promise<TerminalSession> {
        if (this.#disposed) {
            throw new TerminalError("conflict", "That folder is no longer available.");
        }
        const cols = input.cols ?? DEFAULT_TERMINAL_COLS;
        const rows = input.rows ?? DEFAULT_TERMINAL_ROWS;
        const maxScrollback = input.maxScrollback ?? DEFAULT_TERMINAL_SCROLLBACK;
        const colorScheme = input.colorScheme ?? DEFAULT_TERMINAL_COLOR_SCHEME;
        await this.#makeRoom();
        const cwd =
            input.cwd === undefined
                ? this.#root
                : isAbsolute(input.cwd)
                  ? input.cwd
                  : resolve(this.#root, input.cwd);
        const session = await TerminalSession.create({
            cols,
            colorScheme,
            cwd,
            maxScrollback,
            nextVersion: this.#nextVersion,
            onChange: this.#onUpdated,
            processFactory: this.#processFactory,
            processOptions: {
                cols,
                cwd,
                rows,
                ...(input.command === undefined ? {} : { command: input.command }),
                ...(input.shell === undefined ? {} : { shell: input.shell }),
            },
            rows,
            workspaceId: this.#workspaceId,
        });
        // Starting the process is asynchronous, so the folder may have been archived while this
        // shell was coming up. A session that arrives after that ends here instead of joining a
        // collection nobody holds any more and outliving the folder it stands in.
        if (this.#disposed) {
            await session.dispose();
            throw new TerminalError("conflict", "That folder is no longer available.");
        }
        this.#sessions.set(session.id, session);
        this.#onCreated(session.terminal());
        return session;
    }

    async dispose(): Promise<void> {
        this.#disposed = true;
        const sessions = [...this.#sessions.values()];
        this.#sessions.clear();
        await Promise.all(sessions.map(async (session) => await session.dispose()));
    }

    get(terminalId: string): TerminalSession | undefined {
        return this.#sessions.get(terminalId);
    }

    list(): readonly Terminal[] {
        return [...this.#sessions.values()].map((session) => session.terminal());
    }

    get size(): number {
        return this.#sessions.size;
    }

    /**
     * Makes room for one more terminal by discarding a terminal that has already exited.
     *
     * A finished terminal is kept so a person can read what it printed, but it is the first thing
     * to give up when the limit is reached. When every terminal is still running, the limit is real
     * and the request is refused rather than quietly killing someone's work.
     */
    async #makeRoom(): Promise<void> {
        if (this.#sessions.size < MAX_TERMINALS_PER_SCOPE) return;
        const exited = [...this.#sessions.values()].find(
            (session) => session.terminal().status === "exited",
        );
        if (exited === undefined) {
            throw new TerminalError(
                "conflict",
                "This project or workspace already has too many terminals.",
            );
        }
        this.#sessions.delete(exited.id);
        await exited.dispose();
    }
}
