import { createGhosttyTerminal, type GhosttyTerminal } from "@slopus/ghostty-wasm/node";
import {
    GhosttyRemoteTerminalReplica,
    type RemoteTerminalGridState,
    type RemoteTerminalReplica,
} from "@slopus/ghostty-web";

import type { RemoteTerminalColorScheme } from "../terminal/index.js";

export class RemoteTerminalClientReplica implements RemoteTerminalReplica {
    grid: RemoteTerminalGridState | undefined;
    readonly terminal: GhosttyTerminal;
    readonly #vtReplica: GhosttyRemoteTerminalReplica;

    private constructor(terminal: GhosttyTerminal) {
        this.terminal = terminal;
        this.#vtReplica = new GhosttyRemoteTerminalReplica({
            resize: (cols, rows) => terminal.resize(cols, rows),
            snapshot(): never {
                throw new Error("Client Ghostty snapshots are read from the native replica.");
            },
            writeBytes: (data) => terminal.write(data),
        });
    }

    static async create(
        colorScheme: RemoteTerminalColorScheme,
    ): Promise<RemoteTerminalClientReplica> {
        return new RemoteTerminalClientReplica(await createGhosttyTerminal({ colorScheme }));
    }

    applyGrid(state: RemoteTerminalGridState): void {
        this.grid = state;
    }

    applyVt(data: Uint8Array): void | Promise<void> {
        this.grid = undefined;
        return this.#vtReplica.applyVt(data);
    }

    close(): void {
        this.terminal.dispose();
    }

    resize(cols: number, rows: number): void | Promise<void> {
        return this.#vtReplica.resize(cols, rows);
    }
}
