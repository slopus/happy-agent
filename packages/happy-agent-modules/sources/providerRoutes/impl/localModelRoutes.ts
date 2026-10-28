import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { DetectedRoute } from "./DetectedRoute.js";
import { listLocalModels } from "./listLocalModels.js";
import { homeOf, type RouteMachine } from "./RouteMachine.js";

const MAX_PROVIDER_MODELS = 200;

const SERVERS = [
    { id: "lmstudio", name: "LM Studio", folder: ".lmstudio" },
    { id: "ollama", name: "Ollama", folder: ".ollama" },
] as const;

/**
 * LM Studio and Ollama on this computer, asked for their model lists at their ports. A server that
 * does not answer is still shown, as not running, when its folder in the home directory says it
 * is installed. Embedding models are left out: they cannot hold a conversation.
 */
export async function localModelRoutes(
    machine: RouteMachine,
    ports: Readonly<Partial<Record<"lmstudio" | "ollama", number>>>,
): Promise<DetectedRoute[]> {
    const home = homeOf(machine);
    const found = await Promise.all(
        SERVERS.map(async (server): Promise<DetectedRoute[]> => {
            const port = ports[server.id];
            const listed = port === undefined ? undefined : await listLocalModels(port, null);
            const running = listed?.status === "running";
            if (!running && !(await isDirectory(join(home, server.folder)))) return [];
            const models = (listed?.models ?? [])
                .map((model) => model.id)
                .filter((id) => !/embed/iu.test(id));
            const baseUrl = port === undefined ? null : `http://127.0.0.1:${String(port)}/v1`;
            const usable = running && baseUrl !== null && models.length > 0;
            return [
                {
                    id: server.id,
                    kind: "local_models",
                    name: server.name,
                    vendors: [server.name],
                    billing: "local",
                    account: null,
                    endpoint: baseUrl,
                    status: running ? "ready" : "not_running",
                    models: running ? models.map((id) => ({ id, vendor: server.name })) : null,
                    warning: null,
                    ...(!usable
                        ? {}
                        : {
                              provider: {
                                  id: server.id,
                                  table: {
                                      type: "openai_compatible",
                                      name: server.name,
                                      base_url: baseUrl,
                                      // The server needs no key; configuration needs one.
                                      api_key: "local",
                                      models: models.slice(0, MAX_PROVIDER_MODELS),
                                  },
                                  summary: `Adds ${server.name} on this computer with ${String(Math.min(models.length, MAX_PROVIDER_MODELS))} ${models.length === 1 ? "model" : "models"}.`,
                              },
                          }),
                },
            ];
        }),
    );
    return found.flat();
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}
