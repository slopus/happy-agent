import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Compute, ComputeProcess } from "@slopus/happy-agent-compute";
import type { Context } from "@steve.kite/stdlib";

/** How long a server may take to leave after its input closes before it is killed. */
const CLOSE_GRACE_MS = 2_000;

/**
 * An MCP server on a runner, spoken to over its standard input and output.
 *
 * It is the SDK's stdio transport with the process started as one of the runner's product
 * programs instead of a child of the daemon. The server inherits the runner's environment, which
 * holds no Happy credentials, plus the variables its configuration sets.
 */
export class MachineStdioTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    readonly #ctx: Context;
    readonly #machine: Compute;
    readonly #options: {
        readonly args: readonly string[];
        readonly command: string;
        readonly cwd?: string;
        readonly environment?: Readonly<Record<string, string>>;
    };
    readonly #readBuffer = new ReadBuffer();
    #process: ComputeProcess | undefined;
    #started = false;

    constructor(
        ctx: Context,
        machine: Compute,
        options: {
            readonly args: readonly string[];
            readonly command: string;
            readonly cwd?: string;
            readonly environment?: Readonly<Record<string, string>>;
        },
    ) {
        this.#ctx = ctx;
        this.#machine = machine;
        this.#options = options;
    }

    async start(): Promise<void> {
        if (this.#started) throw new Error("The MCP server has already been started.");
        this.#started = true;
        const processes = this.#machine.processes;
        if (processes === undefined) throw new Error("This runner cannot start MCP servers.");
        const child = await processes.start(this.#ctx, {
            command: this.#options.command,
            args: this.#options.args,
            ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
            ...(this.#options.environment === undefined
                ? {}
                : { environment: this.#options.environment }),
        });
        this.#process = child;
        child.onStdout((chunk) => {
            this.#readBuffer.append(Buffer.from(chunk));
            this.#readMessages();
        });
        // The server's log is its own; draining it keeps a chatty server from blocking.
        child.onStderr(() => undefined);
        void child.exited.then(() => {
            this.#process = undefined;
            this.#readBuffer.clear();
            this.onclose?.();
        });
    }

    async send(message: JSONRPCMessage): Promise<void> {
        const child = this.#process;
        if (child === undefined) throw new Error("The MCP server is not running.");
        if (!(await child.write(serializeMessage(message)))) {
            throw new Error("The MCP server has exited.");
        }
    }

    async close(): Promise<void> {
        const child = this.#process;
        if (child === undefined) return;
        child.endInput();
        const timer = setTimeout(() => child.signal("SIGKILL"), CLOSE_GRACE_MS);
        timer.unref();
        child.signal("SIGTERM");
        await child.exited.catch(() => undefined);
        clearTimeout(timer);
    }

    #readMessages(): void {
        for (;;) {
            let message: JSONRPCMessage | null;
            try {
                message = this.#readBuffer.readMessage();
            } catch (error) {
                this.onerror?.(error instanceof Error ? error : new Error(String(error)));
                continue;
            }
            if (message === null) return;
            this.onmessage?.(message);
        }
    }
}
