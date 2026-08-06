import { loadConfig } from "./loadConfig.js";
import type {
    LoadConfigOptions,
    PartialRigConfig,
    P2pNodeRole,
    PartialConfigP2p,
} from "./types.js";
import { updateRuntimeConfig } from "./updateRuntimeConfig.js";

export interface P2pNodeSettings {
    name?: string;
    primaryId?: string;
    role?: P2pNodeRole;
}

export async function writeP2pNodeSettings(
    settings: P2pNodeSettings,
    options: LoadConfigOptions = {},
): Promise<void> {
    const loaded = await loadConfig(options);
    await updateRuntimeConfig(loaded.paths.runtime, async () => {
        const runtime = (await loadConfig(options)).sources.runtime.values;
        const role = settings.role ?? runtime.p2p?.role;
        const p2p: PartialConfigP2p = {
            ...runtime.p2p,
            ...settings,
        };
        if (role === "primary") delete p2p.primaryId;
        return {
            ...runtime,
            p2p,
        } satisfies PartialRigConfig;
    });
}
