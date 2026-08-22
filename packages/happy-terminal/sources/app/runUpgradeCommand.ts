import type { Context } from "@steve.kite/stdlib";

import { HappyTerminalUserError } from "../HappyTerminalUserError.js";
import {
    getHappyDaemonPaths,
    observeLocalProtocolServer,
    resolveLocalHappyAgentSources,
    runDaemonCommand,
    upgradeHappyAgentBinary,
    type HappyAgentBinary,
    type HappyDaemonPaths,
    type UpgradeHappyAgentBinaryOptions,
} from "../daemon/index.js";
import { selectedHappyAgentBinary } from "../daemon/happyAgentBinaryConfig.js";

export interface RunUpgradeCommandOptions {
    ctx?: Context;
    isReleaseInstallation?: () => boolean;
    log?: (line: string) => void;
    paths?: HappyDaemonPaths;
    reloadDaemon?: (log: (line: string) => void, ctx: Context | undefined) => Promise<void>;
    runningVersion?: (paths: HappyDaemonPaths) => Promise<string | undefined>;
    selectedBinary?: (paths: HappyDaemonPaths) => Promise<HappyAgentBinary | undefined>;
    upgradeBinary?: (options: UpgradeHappyAgentBinaryOptions) => Promise<HappyAgentBinary>;
}

export interface UpgradeHappyAgentOptions {
    log?: (line: string) => void;
}

/** Public embedding boundary for the same upgrade performed by `happy-terminal upgrade`. */
export async function upgradeHappyAgent(options: UpgradeHappyAgentOptions = {}): Promise<void> {
    await runUpgradeCommand(options);
}

/** Downloads the latest managed Happy Agent release and reloads the daemon onto it. */
export async function runUpgradeCommand(options: RunUpgradeCommandOptions = {}): Promise<void> {
    const isReleaseInstallation =
        options.isReleaseInstallation ?? (() => resolveLocalHappyAgentSources() === undefined);
    if (!isReleaseInstallation()) {
        throw new HappyTerminalUserError(
            "A local Happy Agent source checkout cannot self-upgrade.",
            {
                hint: "Update and rebuild the source checkout instead.",
            },
        );
    }

    const log = options.log ?? console.log;
    const paths = options.paths ?? getHappyDaemonPaths();
    const selectBinary = options.selectedBinary ?? selectedHappyAgentBinary;
    const installBinary = options.upgradeBinary ?? upgradeHappyAgentBinary;
    const readRunningVersion =
        options.runningVersion ??
        (async (daemonPaths: HappyDaemonPaths) =>
            (await observeLocalProtocolServer(daemonPaths))?.health.version.daemon);
    const reloadDaemon =
        options.reloadDaemon ??
        (async (report: (line: string) => void, ctx: Context | undefined) => {
            if (ctx === undefined) await runDaemonCommand("reload", report);
            else await runDaemonCommand("reload", report, ctx);
        });

    try {
        const [current, runningVersion] = await Promise.all([
            selectBinary(paths),
            readRunningVersion(paths),
        ]);
        const installed = await installBinary({ onStatus: log, paths });
        const selectionChanged = current?.version !== installed.version;
        const shouldReload =
            runningVersion === undefined ? selectionChanged : runningVersion !== installed.version;
        if (!shouldReload) {
            log(`Happy Agent ${installed.version} is already up to date.`);
            return;
        }

        log(
            runningVersion === undefined
                ? `Starting Happy Agent ${installed.version}.`
                : `Restarting with Happy Agent ${installed.version}.`,
        );
        await reloadDaemon(log, options.ctx);
    } catch (error) {
        if (error instanceof HappyTerminalUserError) throw error;
        throw new HappyTerminalUserError("Happy Agent could not be upgraded.", {
            cause: error,
            hint: error instanceof Error ? error.message : String(error),
        });
    }
}
