import {
    ensureLocalProtocolServer,
    ProtocolHttpClient,
    readTokenIfPresent,
    stopLocalProtocolServer,
} from "../client/index.js";
import { getEnvironmentLocalServerPaths } from "../server/index.js";
import type { HealthResponse } from "../protocol/index.js";

export type DaemonCommand = "reload" | "start" | "stop" | "status";

export async function runDaemonCommand(command: DaemonCommand): Promise<void> {
    if (command === "start") {
        const connection = await ensureLocalProtocolServer({
            confirmRestart: async () => true,
        });
        console.log(`Daemon is running at ${connection.paths.socketPath}`);
        console.log(`Daemon diagnostics: ${connection.paths.diagnosticsPath}`);
        return;
    }

    const connection = await connectToExistingDaemon();
    if (command === "reload") {
        if (connection !== undefined) {
            await stopLocalProtocolServer(connection.client);
        }
        const reloaded = await ensureLocalProtocolServer({
            confirmRestart: async () => true,
        });
        console.log(`Daemon is running at ${reloaded.paths.socketPath}`);
        console.log(`Daemon diagnostics: ${reloaded.paths.diagnosticsPath}`);
        return;
    }

    if (command === "status") {
        if (connection === undefined) {
            console.log("Daemon is not running.");
            console.log(`Daemon diagnostics: ${getEnvironmentLocalServerPaths().diagnosticsPath}`);
            return;
        }
        if (connection.health.status === "error") {
            console.log(`Daemon could not start: ${connection.health.error}`);
            console.log(`Daemon diagnostics: ${getEnvironmentLocalServerPaths().diagnosticsPath}`);
            return;
        }
        if (connection.health.status === "starting") {
            console.log(`Daemon is starting at ${connection.client.socketPath}`);
            console.log(`Daemon diagnostics: ${getEnvironmentLocalServerPaths().diagnosticsPath}`);
            return;
        }
        console.log(`Daemon is running at ${connection.client.socketPath}`);
        try {
            const p2p = await connection.client.getP2pStatus();
            if (p2p.transports.length === 0) console.log("P2P networking is disabled.");
            if (p2p.instanceId !== undefined) {
                console.log(`P2P instance: ${p2p.instanceId}`);
            }
            if (p2p.publicKey !== undefined) {
                console.log(`P2P public key: ${p2p.publicKey}`);
            }
            for (const transport of p2p.transports) {
                if (transport.state === "unavailable") {
                    console.log(
                        `${describeTransport(transport.transport)} P2P networking is unavailable: ${transport.error}`,
                    );
                    continue;
                }
                const label = describeTransport(transport.transport);
                if ("localAddress" in transport && transport.localAddress !== undefined) {
                    console.log(`${label} P2P endpoint: ${transport.localAddress}`);
                }
                if ("apiExposed" in transport) {
                    console.log(
                        `${label} P2P API sharing: ${transport.apiExposed ? "Enabled" : "Disabled"}`,
                    );
                }
                for (const peer of transport.peers) {
                    const latency =
                        peer.rttMs === undefined ? "" : ` (${String(Math.round(peer.rttMs))} ms)`;
                    const error = peer.error === undefined ? "" : ` — ${peer.error}`;
                    const identity =
                        peer.peerId === undefined
                            ? `unverified endpoint ${peer.address}`
                            : `${peer.peerId} via endpoint ${peer.address}`;
                    console.log(
                        `${label} P2P peer ${identity}: ${describePeerStatus(peer.status)}${latency}${error}`,
                    );
                }
            }
        } catch {
            // A daemon from before the P2P status route still has a useful status.
            console.log("P2P status is unavailable from this daemon.");
        }
        console.log(`Daemon diagnostics: ${getEnvironmentLocalServerPaths().diagnosticsPath}`);
        return;
    }

    if (connection === undefined) {
        console.log("Daemon is not running.");
        return;
    }
    await connection.client.shutdown();
    console.log("Daemon is stopping.");
}

function describeTransport(transport: "direct" | "iroh" | "ssh"): string {
    if (transport === "direct") return "Direct";
    if (transport === "ssh") return "SSH";
    return "Iroh";
}

function describePeerStatus(status: "connected" | "connecting" | "unreachable"): string {
    if (status === "connected") return "Connected";
    if (status === "connecting") return "Connecting";
    return "Unreachable";
}

async function connectToExistingDaemon(): Promise<
    | {
          client: ProtocolHttpClient;
          health: HealthResponse;
      }
    | undefined
> {
    const paths = getEnvironmentLocalServerPaths();
    const token = await readTokenIfPresent(paths.tokenPath);
    if (token === undefined) {
        return undefined;
    }

    const client = new ProtocolHttpClient({
        socketPath: paths.socketPath,
        token,
    });
    try {
        const health = await client.health();
        return { client, health };
    } catch {
        return undefined;
    }
}
