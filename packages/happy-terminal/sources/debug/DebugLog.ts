import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createDebugJsonReplacer } from "./createDebugJsonReplacer.js";

export interface DebugLogOptions {
    directory: string;
    now?: () => number;
}

export class DebugLog {
    readonly directory: string;

    #now: () => number;
    #pending: Promise<void>;
    #sequence = 0;

    constructor(options: DebugLogOptions) {
        this.directory = options.directory;
        this.#now = options.now ?? Date.now;
        this.#pending = this.#initialize();
        void this.#pending.catch(() => undefined);
    }

    flush(): Promise<void> {
        return this.#pending;
    }

    record(type: string, data: unknown): Promise<void> {
        const sequence = ++this.#sequence;
        const timestampMs = this.#now();
        const safeType = type.replace(/[^a-zA-Z0-9_-]/gu, "-");
        const fileName = `${String(sequence).padStart(10, "0")}-${safeType}.json`;
        const body = `${JSON.stringify(
            {
                data,
                sequence,
                timestamp: new Date(timestampMs).toISOString(),
                timestampMs,
                type,
            },
            createDebugJsonReplacer(),
            2,
        )}\n`;
        const operation = this.#pending
            .catch(() => undefined)
            .then(() => writeFile(join(this.directory, fileName), body, { mode: 0o600 }));
        const settled = operation.catch(() => undefined);
        this.#pending = settled;
        return settled;
    }

    async #initialize(): Promise<void> {
        const root = dirname(this.directory);
        await mkdir(this.directory, { mode: 0o700, recursive: true });
        await writeFile(join(root, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }).catch(
            (error: unknown) => {
                if (!isAlreadyExistsError(error)) throw error;
            },
        );
    }
}

function isAlreadyExistsError(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
    );
}
