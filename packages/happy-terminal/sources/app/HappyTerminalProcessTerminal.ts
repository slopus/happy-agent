import { ProcessTerminal } from "@earendil-works/pi-tui";

import {
    createTerminalInputBurstHandler,
    type TerminalInputBurstHandler,
} from "./createTerminalInputBurstHandler.js";
import { TerminalOutputTrace } from "./TerminalOutputTrace.js";

export class HappyTerminalProcessTerminal extends ProcessTerminal {
    #inputBurstHandler: TerminalInputBurstHandler | undefined;
    readonly #trace = new TerminalOutputTrace();

    override start(onInput: (data: string) => void, onResize: () => void): void {
        this.#inputBurstHandler?.dispose();
        this.#inputBurstHandler = createTerminalInputBurstHandler(onInput);
        super.start(
            (data) => {
                this.#trace.recordInput(data, this.#dimensions());
                this.#inputBurstHandler?.handle(data);
            },
            () => {
                this.#trace.recordResize("signal", this.#dimensions());
                onResize();
            },
        );
    }

    override write(data: string): void {
        this.#trace.recordOutput(data, this.#dimensions());
        super.write(data);
    }

    override stop(): void {
        this.#inputBurstHandler?.dispose();
        this.#inputBurstHandler = undefined;
        super.stop();
    }

    #dimensions(): { columns: number; rows: number } {
        return { columns: this.columns, rows: this.rows };
    }
}
