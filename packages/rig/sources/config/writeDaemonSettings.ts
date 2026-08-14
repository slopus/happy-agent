import { loadConfig } from "./loadConfig.js";
import type { DaemonSettings, LoadConfigOptions, PartialRigConfig } from "./types.js";
import { updateRuntimeConfig } from "./updateRuntimeConfig.js";

export async function writeDaemonSettings(
    settings: Pick<
        DaemonSettings,
        "inferenceMaxRetries" | "inferenceFatalRetries" | "durableGlobalEventQueue"
    >,
    options: LoadConfigOptions = {},
    p2pName?: string,
): Promise<void> {
    const loaded = await loadConfig(options);
    await updateRuntimeConfig(loaded.paths.runtime, async () => {
        const runtime = (await loadConfig(options)).sources.runtime.values;
        return {
            ...(runtime.defaults === undefined ? {} : { defaults: runtime.defaults }),
            ...(runtime.presence === undefined ? {} : { presence: runtime.presence }),
            ...(runtime.p2p === undefined && p2pName === undefined
                ? {}
                : {
                      p2p: {
                          ...runtime.p2p,
                          ...(p2pName === undefined ? {} : { name: p2pName }),
                      },
                  }),
            ...(runtime.providerDefaultEnable === undefined
                ? {}
                : { providerDefaultEnable: runtime.providerDefaultEnable }),
            ...(runtime.providers === undefined ? {} : { providers: runtime.providers }),
            ...(runtime.theme === undefined ? {} : { theme: runtime.theme }),
            settings: {
                ...runtime.settings,
                inferenceMaxRetries: settings.inferenceMaxRetries,
                inferenceFatalRetries: settings.inferenceFatalRetries,
                durableGlobalEventQueue: settings.durableGlobalEventQueue,
            },
        } satisfies PartialRigConfig;
    });
}
