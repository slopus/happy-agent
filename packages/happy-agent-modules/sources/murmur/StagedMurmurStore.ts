import {
    MAXIMUM_STORE_SCAN_ITEMS,
    type MurmurStore,
    type StoreScanOptions,
    type StoreTransaction,
} from "@slopus/murmur";

import type { SqliteMurmurStore } from "./SqliteMurmurStore.js";

const COPY_PAGE_SIZE = 1_000;
const MAXIMUM_COPIED_ENTRIES = 100_000;
const MAXIMUM_COPIED_BYTES = 256 * 1_024 * 1_024;

/**
 * A bounded temporary identity store used while reset proves its external prerequisites.
 *
 * MurmurClient holds one store for its lifetime. Opening the replacement against this memory
 * stage proves that the complete replacement identity can be created before reset touches old
 * durable keys. Once the staged entries have been installed atomically, the same client switches
 * to SQLite without being reopened in the vulnerable gap. Reset also revokes invitations against
 * a copy of the old store because Murmur deliberately records failed revocations locally; throwing
 * that copy away on failure keeps Happy's old durable identity byte-for-byte unchanged.
 */
export class StagedMurmurStore implements MurmurStore {
    #closed = false;
    #delegate: SqliteMurmurStore | undefined;
    #entries = new Map<string, Uint8Array>();
    #tail: Promise<void> = Promise.resolve();

    /** Copy a durable store with explicit entry and byte ceilings. */
    static async copyOf(source: MurmurStore): Promise<StagedMurmurStore> {
        const staged = new StagedMurmurStore();
        let after: string | undefined;
        let entries = 0;
        let bytes = 0;
        try {
            for (;;) {
                const page = await source.scan("", {
                    ...(after === undefined ? {} : { after }),
                    limit: COPY_PAGE_SIZE,
                });
                if (page.size === 0) return staged;
                for (const [key, value] of page) {
                    entries += 1;
                    bytes += Buffer.byteLength(key) + value.byteLength;
                    if (entries > MAXIMUM_COPIED_ENTRIES || bytes > MAXIMUM_COPIED_BYTES) {
                        throw new Error("The Murmur store is too large to stage safely.");
                    }
                    staged.#entries.set(key, value.slice());
                    after = key;
                }
            }
        } catch (error: unknown) {
            await staged.close();
            throw error;
        }
    }

    async get(key: string): Promise<Uint8Array | undefined> {
        return await this.#exclusive(async () => {
            this.#requireOpen();
            if (this.#delegate !== undefined) return await this.#delegate.get(key);
            return clone(this.#entries.get(key));
        });
    }

    async set(key: string, value: Uint8Array): Promise<void> {
        await this.#exclusive(async () => {
            this.#requireOpen();
            if (this.#delegate !== undefined) {
                await this.#delegate.set(key, value);
                return;
            }
            this.#entries.set(key, value.slice());
        });
    }

    async delete(key: string): Promise<void> {
        await this.#exclusive(async () => {
            this.#requireOpen();
            if (this.#delegate !== undefined) {
                await this.#delegate.delete(key);
                return;
            }
            this.#entries.delete(key);
        });
    }

    async list(prefix: string): Promise<ReadonlyMap<string, Uint8Array>> {
        return await this.scan(prefix, { limit: MAXIMUM_STORE_SCAN_ITEMS });
    }

    async scan(
        prefix: string,
        options: StoreScanOptions,
    ): Promise<ReadonlyMap<string, Uint8Array>> {
        return await this.#exclusive(async () => {
            this.#requireOpen();
            if (this.#delegate !== undefined) return await this.#delegate.scan(prefix, options);
            validateLimit(options.limit);
            return page(this.#entries, prefix, options);
        });
    }

    async transaction<Result>(
        operation: (transaction: StoreTransaction) => Promise<Result>,
    ): Promise<Result> {
        return await this.#exclusive(async () => {
            this.#requireOpen();
            if (this.#delegate !== undefined) return await this.#delegate.transaction(operation);

            const draft = cloneMap(this.#entries);
            let active = true;
            const requireActive = (): void => {
                if (!active) throw new Error("Murmur transaction is closed");
            };
            const transaction: StoreTransaction = {
                delete: async (key) => {
                    requireActive();
                    draft.delete(key);
                },
                get: async (key) => {
                    requireActive();
                    return clone(draft.get(key));
                },
                list: async (prefix) => {
                    requireActive();
                    return page(draft, prefix, { limit: MAXIMUM_STORE_SCAN_ITEMS });
                },
                scan: async (prefix, options) => {
                    requireActive();
                    validateLimit(options.limit);
                    return page(draft, prefix, options);
                },
                set: async (key, value) => {
                    requireActive();
                    draft.set(key, value.slice());
                },
            };
            try {
                const result = await operation(transaction);
                this.#entries = draft;
                return result;
            } finally {
                active = false;
            }
        });
    }

    /** A defensive snapshot installed into SQLite by the reset transaction. */
    async snapshot(): Promise<ReadonlyMap<string, Uint8Array>> {
        return await this.#exclusive(async () => {
            this.#requireOpen();
            if (this.#delegate !== undefined) {
                throw new Error("The staged Murmur store is already durable.");
            }
            return cloneMap(this.#entries);
        });
    }

    /** Switch every future client operation to the already-populated durable store. */
    async attach(delegate: SqliteMurmurStore): Promise<void> {
        await this.#exclusive(async () => {
            this.#requireOpen();
            if (this.#delegate !== undefined)
                throw new Error("The Murmur store is already attached.");
            this.#delegate = delegate;
            this.#entries.clear();
        });
    }

    async close(): Promise<void> {
        await this.#exclusive(async () => {
            if (this.#closed) return;
            this.#closed = true;
            this.#entries.clear();
            await this.#delegate?.close();
        });
    }

    #exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
        const result = this.#tail.then(operation, operation);
        this.#tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    #requireOpen(): void {
        if (this.#closed) throw new Error("Murmur store is closed");
    }
}

function page(
    entries: ReadonlyMap<string, Uint8Array>,
    prefix: string,
    options: StoreScanOptions,
): ReadonlyMap<string, Uint8Array> {
    const selected = [...entries.entries()]
        .filter(
            ([key]) =>
                key.startsWith(prefix) && (options.after === undefined || key > options.after),
        )
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, options.limit)
        .map(([key, value]) => [key, value.slice()] as const);
    return new Map(selected);
}

function clone(value: Uint8Array | undefined): Uint8Array | undefined {
    return value?.slice();
}

function cloneMap(source: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
    return new Map([...source].map(([key, value]) => [key, value.slice()]));
}

function validateLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_STORE_SCAN_ITEMS) {
        throw new Error("Invalid Murmur store scan limit");
    }
}
