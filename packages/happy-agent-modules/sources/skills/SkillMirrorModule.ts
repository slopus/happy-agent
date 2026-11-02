import type { AgentModule, AgentModuleHooks } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import type { DurableFunctionsModule } from "../durableFunctions/index.js";
import type { RunnersModule } from "../runners/index.js";
import type { GlobalSkillsModule } from "./GlobalSkillsModule.js";
import { collectMirroredSkills, type MirroredSkillHashes } from "./impl/collectMirroredSkills.js";
import { collectMirroredFolder } from "./impl/collectMirroredFolder.js";
import { writeMirroredFolder, writeSkillMirror } from "./impl/writeSkillMirror.js";

const MIRROR = "skill-mirror";
/** How often every machine is checked again, which also picks up edits to configured folders. */
const RECHECK_INTERVAL_MS = 5 * 60_000;
/** How long a burst of changes settles before a sync starts. */
const SETTLE_MS = 250;
/** The workload user's runner on this machine, which has no runner ID. */
const LOCAL = "";

/**
 * Copies this installation's documentation and skills to the machines runners serve, so an agent
 * working there can use them: the documentation and native skills this release ships, and the
 * installation's own skills — the installed global skills that are enabled, and the configured
 * skill folders.
 *
 * Skills are files the agent reads and runs on its own machine, scripts and references included,
 * so a skill living only on the daemon's disk is unusable on a runner. Each connected runner, and
 * the workload user's runner on this machine, holds a copy in its `synced-skills` folder, which
 * discovery there scans as user skills behind the runner's own `~/.agents/skills`, beside the
 * documentation and native skills, which every runner gets. A runner gets a copy when it connects, whenever the installed skills change, and on a periodic recheck that
 * also notices edits to configured folders; only skills it lacks are sent. A runner configured
 * with `sync_skills = false` receives none of the installation's skills, and a copy it already had
 * is removed.
 */
export class SkillMirrorModule implements AgentModule {
    readonly name = "skill-mirror";

    readonly #config: ConfigModule;
    readonly #runners: RunnersModule;
    readonly #globalSkills: GlobalSkillsModule;
    readonly #durable: DurableFunctionsModule;
    readonly #hashes: MirroredSkillHashes = new Map();
    /** Machines whose copy may be out of date, by runner ID, with `LOCAL` for the workload user. */
    readonly #dirty = new Set<string>();
    readonly #connected = new Set<string>();
    #wake: (() => void) | undefined;
    #unsubscribe: (() => void)[] = [];
    #closed = false;
    #loop: Promise<void> | undefined;

    /**
     * @param config Where this installation's skills are, and which runners opted out.
     * @param runners The machines runners serve, and when they connect.
     * @param globalSkills The installed global skills, which are enabled, and when they change.
     * @param durable Owns the long-lived sync loop, so it starts again after a restart.
     */
    constructor(
        config: ConfigModule,
        runners: RunnersModule,
        globalSkills: GlobalSkillsModule,
        durable: DurableFunctionsModule,
    ) {
        this.#config = config;
        this.#runners = runners;
        this.#globalSkills = globalSkills;
        this.#durable = durable;
        durable.register({
            name: MIRROR,
            argumentsSchema: Type.Object({}),
            resultSchema: Type.Null(),
            executor: async (ctx) => {
                this.#loop = this.#run(ctx);
                await this.#loop;
                return null;
            },
        });
    }

    readonly beforeStart = (_ctx: Context): AgentModuleHooks => {
        this.#unsubscribe.push(
            this.#runners.onUpdated((_updateCtx, snapshot) => {
                const connected = snapshot.runners
                    .filter((runner) => runner.status === "connected")
                    .map((runner) => runner.id);
                for (const id of connected) if (!this.#connected.has(id)) this.#mark(id);
                this.#connected.clear();
                for (const id of connected) this.#connected.add(id);
            }),
            this.#globalSkills.onUpdated(() => {
                this.#markAll();
            }),
        );
        return {
            afterStart: async (startCtx) => {
                await this.#durable.invoke(startCtx, {
                    function: MIRROR,
                    arguments: {},
                    operationId: MIRROR,
                    lockKeys: [MIRROR],
                });
            },
        };
    };

    async close(): Promise<void> {
        this.#closed = true;
        for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
        this.#wake?.();
        await this.#loop;
    }

    /** Sync every machine that may be out of date, one at a time, until the module closes. */
    async #run(ctx: Context): Promise<void> {
        // The durable call is this loop's own lifetime, named for it by the dispatcher.
        const loopCtx = ctx;
        // Runners that connected before this loop started announced it to nobody.
        for (const runner of (await this.#runners.getSnapshot(loopCtx)).runners) {
            if (runner.status === "connected") this.#connected.add(runner.id);
        }
        this.#markAll();
        let recheckAt = Date.now() + RECHECK_INTERVAL_MS;
        while (!this.#closed && ctx.lifetime?.aborted !== true) {
            if (this.#dirty.size === 0) {
                await this.#sleep(Math.max(0, recheckAt - Date.now()));
                if (Date.now() >= recheckAt) {
                    this.#markAll();
                    recheckAt = Date.now() + RECHECK_INTERVAL_MS;
                }
                continue;
            }
            await this.#sleep(SETTLE_MS);
            const targets = [...this.#dirty];
            this.#dirty.clear();
            for (const target of targets) {
                if (this.#closed) return;
                await this.#sync(loopCtx, target).catch((error: unknown) => {
                    loopCtx.log.warn(
                        `Skills could not be copied to ${this.#describe(target)}.`,
                        {},
                        error,
                    );
                });
            }
        }
    }

    async #sync(ctx: Context, target: string): Promise<void> {
        const runnerId = target === LOCAL ? undefined : target;
        if (runnerId !== undefined && !this.#connected.has(runnerId)) return;
        if (runnerId === undefined && this.#runners.workloadUser === undefined) return;
        const machine = await this.#runners.machine(runnerId);
        const home = machine.fs.home;
        if (home === undefined) return;
        const paths = this.#runners.paths(runnerId);
        const files = this.#runners.productFilesOn(home, paths);
        const readOnly = this.#runners.platform(runnerId) !== "win32";
        // The documentation and native skills are the product's own, so every runner gets them.
        const product = this.#config.configuration.paths;
        const copied: string[] = [];
        for (const [source, destination, label] of [
            [product.docsHome, files.docs, "documentation"],
            [product.skillsHome, files.skills, "native skills"],
        ] as const) {
            const folder = await collectMirroredFolder(source);
            if (folder === undefined) continue;
            if (await writeMirroredFolder(machine, paths, destination, folder, { readOnly })) {
                copied.push(label);
            }
        }
        const enabled =
            runnerId === undefined || this.#config.runners.entries[runnerId]?.syncSkills !== false;
        const collected = enabled
            ? await collectMirroredSkills(
                  [this.#config.globalSkillsRoot, ...this.#config.globalSkillDirectories],
                  await this.#globalSkills.unavailableLocations(ctx),
                  this.#hashes,
              )
            : { skills: [], skipped: [] };
        for (const skipped of collected.skipped) {
            ctx.log.warn(`A skill was not copied to ${this.#describe(target)}: ${skipped}.`);
        }
        const changes = await writeSkillMirror(
            machine,
            paths,
            files.syncedSkills,
            collected.skills,
            { readOnly },
        );
        if (copied.length > 0 || changes.written.length > 0 || changes.removed.length > 0) {
            ctx.log.info(
                `Copied to ${this.#describe(target)}: ${[...copied, `${String(changes.written.length)} skills`].join(", ")}; ${String(changes.removed.length)} skills removed.`,
            );
        }
    }

    #mark(target: string): void {
        this.#dirty.add(target);
        this.#wake?.();
    }

    #markAll(): void {
        if (this.#runners.workloadUser !== undefined) this.#dirty.add(LOCAL);
        for (const id of this.#connected) this.#dirty.add(id);
        this.#wake?.();
    }

    async #sleep(ms: number): Promise<void> {
        await new Promise<void>((resolve) => {
            const timer = setTimeout(done, ms);
            timer.unref?.();
            function done() {
                clearTimeout(timer);
                resolve();
            }
            this.#wake = done;
        });
        this.#wake = undefined;
    }

    #describe(target: string): string {
        return target === LOCAL
            ? `the workload user's runner`
            : `the runner ${this.#runners.displayName(target)}`;
    }
}
