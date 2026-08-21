import type { GhosttyTerminal } from "@slopus/ghostty-wasm/node";
import {
    type RemoteTerminalProtocolClient,
    type RemoteTerminalReconnectState,
    type RemoteTerminalScrollbackPage,
} from "@slopus/ghostty-web";

import type { RemoteTerminalClientReplica } from "./RemoteTerminalClientReplica.js";

export class RemoteTerminalAttachment {
    readonly clientId: string;
    readonly exited: Promise<number | null>;
    readonly protocol: RemoteTerminalProtocolClient;
    readonly replica: RemoteTerminalClientReplica;
    readonly terminal: GhosttyTerminal;
    #resolveExit!: (exitCode: number | null) => void;

    constructor(
        clientId: string,
        replica: RemoteTerminalClientReplica,
        createProtocol: (onExit: (exitCode: number | null) => void) => RemoteTerminalProtocolClient,
    ) {
        this.clientId = clientId;
        this.replica = replica;
        this.terminal = replica.terminal;
        this.exited = new Promise((resolve) => {
            this.#resolveExit = resolve;
        });
        this.protocol = createProtocol((exitCode) => this.#resolveExit(exitCode));
    }

    close(): void {
        this.protocol.close();
    }

    reconnectState(): RemoteTerminalReconnectState {
        return this.protocol.reconnectState();
    }

    requestScrollback(
        start: number,
        count: number,
        basis?: { historyEpoch: string; historyRevision: number },
    ): Promise<RemoteTerminalScrollbackPage> {
        return this.protocol.requestScrollback(start, count, basis);
    }

    writeInput(data: Uint8Array | string): number {
        return this.protocol.writeInput(data);
    }
}
