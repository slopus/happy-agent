import { AgentStorage, agentDatabaseConnection, withAgentDatabase } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { openHappyAgentDatabase } from "../../sources/runtime/HappyAgentDatabase.js";
import { WorkspaceMutations } from "../../sources/workspaces/WorkspaceMutations.js";

async function main(): Promise<void> {
    const defer = () => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => (resolve = r));
        return { promise, resolve };
    };
    const path = process.argv[2];
    if (path === undefined) throw new Error("The workspace deadlock probe needs a database path.");
    const opened = await openHappyAgentDatabase(path);
    const root = createRootContext();
    const ctx = withAgentDatabase(root.named("probe"), opened.database);
    const storage = new AgentStorage({
        database: opened.database,
        acquireLock: async () => ({ release: async () => {} }),
    });
    await storage.migrate(ctx, []);
    await storage.kv.write(ctx, "responsive", true);
    // runTransaction owns scheduling; these callbacks deliberately roll back before
    // any WorkspaceStore operation is needed.
    const mutations = new WorkspaceMutations({} as never);
    const entered = defer(),
        externalRequested = defer(),
        continueParent = defer();
    const owner = agentDatabaseConnection(opened.database);
    if (owner === undefined) throw new Error("The probe database has no lifecycle owner.");
    const orig = owner.transaction.bind(owner);
    let watch = false;
    owner.transaction = async (work, committed) => {
        if (watch) externalRequested.resolve();
        return await orig(work, committed);
    };
    const parent = ctx.inTx(async (txCtx) => {
        entered.resolve();
        await continueParent.promise;
        await mutations.runTransaction(txCtx, async () => {
            throw Error("inner-completed");
        });
    });
    parent.catch(() => {});
    // Admit an ordinary mutation while the caller owns the database. Its request
    // for the database proves it has reached the contention boundary.
    await entered.promise;
    watch = true;
    const external = mutations.runTransaction(
        withAgentDatabase(root.named("ordinary-workspace-mutation"), opened.database),
        async () => {
            throw Error("external-completed");
        },
    );
    external.catch(() => {});
    // The caller now joins the very same workspace mutation owner. Both operations
    // must unwind, and an unrelated database read must remain responsive.
    await externalRequested.promise;
    watch = false;
    continueParent.resolve();
    const unrelated = storage.kv.read(ctx, "responsive");
    process.stdout.write("READY\n");
    const results = await Promise.allSettled([parent, external, unrelated]);

    if (results[0].status !== "rejected" || results[0].reason.message !== "inner-completed")
        throw Error("inner did not execute");
    if (results[1].status !== "rejected" || results[1].reason.message !== "external-completed")
        throw Error("external did not execute");
    if (results[2].status !== "fulfilled" || results[2].value !== true)
        throw Error("The unrelated database read did not return the stored value.");
    await opened.close();
    process.stdout.write("PASS\n");
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
