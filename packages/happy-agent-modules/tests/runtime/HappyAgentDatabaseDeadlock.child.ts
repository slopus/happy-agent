import {
    AgentKV,
    AgentStorage,
    agentDatabaseConnection,
    withAgentDatabase,
    type AgentPersistence,
} from "@slopus/happy-agent-base";
import { createRootContext, mapAsyncLock, type Context } from "@steve.kite/stdlib";

import { grokReadFileTool } from "../../sources/compute/tools/grok/read_file.js";
import { grokSearchReplaceTool } from "../../sources/compute/tools/grok/search_replace.js";
import { FileReadLog } from "../../sources/impl/FileReadLog.js";
import { openHappyAgentDatabase } from "../../sources/runtime/HappyAgentDatabase.js";
import { FakeCompute } from "../compute/support/FakeCompute.js";

const AGENT_ID = "database-deadlock-agent";
const FILE_PATH = "/workspace/example.ts";

async function main(): Promise<void> {
    const path = process.argv[2];
    if (path === undefined) throw new Error("The deadlock probe needs a database path.");

    const root = createRootContext();
    const ctx = root.named("happy-agent-database-deadlock-probe");
    const opened = await openHappyAgentDatabase(path);
    const databaseCtx = (name: string): Context =>
        withAgentDatabase(root.named(name), opened.database);
    const storage = new AgentStorage({
        database: opened.database,
        acquireLock: async () => ({ release: async () => {} }),
    });
    await storage.migrate(ctx, []);
    await storage.kv.write(ctx, "responsive", { value: true });

    const persistence = storage.persistence(AGENT_ID);
    const databaseRequested = deferred<void>();
    let watchSearchDatabase = false;
    let watchedTransactions = 0;
    const connection = agentDatabaseConnection(opened.database);
    if (connection === undefined) throw new Error("The probe database has no lifecycle owner.");
    const operation = connection.operation.bind(connection);
    const transaction = connection.transaction.bind(connection);
    connection.operation = async (database, work) => {
        if (watchSearchDatabase) databaseRequested.resolve();
        return await operation(database, work);
    };
    connection.transaction = async (work, committed) => {
        if (watchSearchDatabase) watchedTransactions += 1;
        return await transaction(work, committed);
    };
    const readKV = moduleKV(persistence);
    const searchKV = moduleKV(persistence);
    const readLocks = mapAsyncLock<string>();
    const { compute, searchReadyToRecord, allowSearchRecord, readReadyToRecord, allowReadRecord } =
        computeWithGates();
    const readTool = grokReadFileTool(compute, new FileReadLog(readKV, readLocks, AGENT_ID));
    const searchTool = grokSearchReplaceTool(
        compute,
        new FileReadLog(searchKV, readLocks, AGENT_ID),
    );

    const search = searchTool.execute(
        databaseCtx("search-replace"),
        {
            file_path: FILE_PATH,
            old_string: "before",
            new_string: "after",
        },
        undefined as never,
    );
    await searchReadyToRecord.promise;

    const read = persistence.transaction(databaseCtx("transactional-read-file"), async (txCtx) =>
        readTool.execute(txCtx, { target_file: FILE_PATH }, undefined as never),
    );
    await readReadyToRecord.promise;

    watchSearchDatabase = true;
    allowSearchRecord.resolve();
    await databaseRequested.promise;

    allowReadRecord.resolve();
    const unrelated = storage.kv.read(databaseCtx("unrelated-database-read"), "responsive");
    process.stdout.write("READY\n");

    const [searchResult, readResult, unrelatedResult] = await Promise.all([
        search,
        read,
        unrelated,
    ]);
    if (searchResult.replacements !== 1) throw new Error("search_replace did not finish.");
    if (!readResult.content.includes("after")) throw new Error("read_file returned stale text.");
    if ((unrelatedResult as { value?: unknown } | undefined)?.value !== true) {
        throw new Error("The unrelated database read returned the wrong value.");
    }
    if (watchedTransactions !== 0) {
        throw new Error("search_replace opened a new libSQL transaction to record its edit.");
    }

    await opened.close();
    process.stdout.write("PASS\n");
}

function moduleKV(persistence: AgentPersistence): AgentKV {
    return new AgentKV(persistence, `kv.${AGENT_ID}.`).scoped("module", "compute");
}

function computeWithGates(): {
    readonly compute: FakeCompute;
    readonly searchReadyToRecord: Deferred<void>;
    readonly allowSearchRecord: Deferred<void>;
    readonly readReadyToRecord: Deferred<void>;
    readonly allowReadRecord: Deferred<void>;
} {
    const compute = new FakeCompute();
    compute.write(FILE_PATH, "export const value = 'before';\n");
    const searchReadyToRecord = deferred<void>();
    const allowSearchRecord = deferred<void>();
    const readReadyToRecord = deferred<void>();
    const allowReadRecord = deferred<void>();
    const stat = compute.fs.stat;
    const readFile = compute.fs.readFile;
    let heldSearchStat = false;
    let targetReads = 0;

    compute.fs.stat = async (permissions, path) => {
        const result = await stat(permissions, path);
        if (
            path === FILE_PATH &&
            !heldSearchStat &&
            compute.files.get(FILE_PATH)?.content.includes("after") === true
        ) {
            heldSearchStat = true;
            searchReadyToRecord.resolve();
            await allowSearchRecord.promise;
        }
        return result;
    };
    compute.fs.readFile = async (permissions, path) => {
        const result = await readFile(permissions, path);
        if (path === FILE_PATH) {
            targetReads += 1;
            if (targetReads === 2) {
                readReadyToRecord.resolve();
                await allowReadRecord.promise;
            }
        }
        return result;
    };

    return {
        compute,
        searchReadyToRecord,
        allowSearchRecord,
        readReadyToRecord,
        allowReadRecord,
    };
}

interface Deferred<Value> {
    readonly promise: Promise<Value>;
    resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

const keepAlive = setInterval(() => undefined, 1_000);
void main().then(
    () => clearInterval(keepAlive),
    (error: unknown) => {
        clearInterval(keepAlive);
        process.stderr.write(
            `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
        process.exitCode = 1;
    },
);
