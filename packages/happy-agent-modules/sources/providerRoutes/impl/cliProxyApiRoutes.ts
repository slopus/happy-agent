import type { DetectedRoute } from "./DetectedRoute.js";
import { detectCliProxyApi } from "./detectCliProxyApi.js";
import type { RouteMachine } from "./RouteMachine.js";

/** The most models a generated provider lists; configuration arrays hold at most 256. */
const MAX_PROVIDER_MODELS = 200;

/**
 * A CLIProxyAPI the person already runs, as one route. It re-serves subscription sign-ins, so it
 * overlaps those vendors' own routes. Choosing it adds the recommended OpenAI-compatible provider
 * at the local proxy with the proxy's own client key.
 */
export async function cliProxyApiRoutes(machine: RouteMachine): Promise<DetectedRoute[]> {
    const proxy = await detectCliProxyApi(machine);
    if (proxy === null) return [];
    const baseUrl = `http://127.0.0.1:${String(proxy.port)}/v1`;
    const models = proxy.models.slice(0, MAX_PROVIDER_MODELS).map((model) => model.id);
    return [
        {
            id: "cliproxyapi",
            kind: "local_proxy",
            name: "CLIProxyAPI",
            vendors: [...proxy.vendors],
            billing: "subscription",
            account: null,
            endpoint: baseUrl,
            status:
                proxy.status === "running"
                    ? "ready"
                    : proxy.status === "unauthorized"
                      ? "unauthorized"
                      : "not_running",
            models: proxy.status === "running" ? [...proxy.models] : null,
            warning: null,
            ...(models.length === 0
                ? {}
                : {
                      provider: {
                          id: "cliproxyapi",
                          table: {
                              type: "openai_compatible",
                              name: "CLIProxyAPI",
                              base_url: baseUrl,
                              // A proxy without client keys accepts any; configuration needs one.
                              api_key: proxy.apiKey ?? "local",
                              models,
                          },
                          summary: `Adds CLIProxyAPI on this computer with ${String(models.length)} ${models.length === 1 ? "model" : "models"}.`,
                      },
                  }),
        },
    ];
}
