import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { registrySchema } from "./contracts.js";
import { GuestStore } from "./persistence/GuestStore.js";
import { createGuestServer } from "./GuestServer.js";

async function main(): Promise<void> {
    const [command, directory, ...args] = process.argv.slice(2);
    if (directory === undefined)
        throw new Error(
            "Usage: start <serve|invite|revoke|reports> <private state directory> [arguments]. See README.",
        );
    const store = await GuestStore.open(directory);
    if (command === "invite") {
        const [botId, botName, output, publicOrigin, name = "Guest", mode = "write"] = args;
        if (
            botId === undefined ||
            botName === undefined ||
            output === undefined ||
            publicOrigin === undefined
        )
            throw new Error(
                "Usage: start invite <state> <bot ID> <bot name> <new private output file> <HTTPS origin> [guest name] [read-only|write]",
            );
        const origin = new URL(publicOrigin);
        if (
            origin.protocol !== "https:" ||
            origin.pathname !== "/" ||
            origin.search ||
            origin.hash ||
            origin.username ||
            origin.password
        )
            throw new Error(
                "The public origin must be an HTTPS origin without a path or credentials.",
            );
        if (name.length > 256 || botName.length > 256 || (mode !== "read-only" && mode !== "write"))
            throw new Error("The name or invitation mode is invalid.");
        const invite = await store.createInvite({
            botId,
            botName,
            name,
            expiresAt: Date.now() + 86_400_000,
            readOnly: mode === "read-only",
        });
        // A raw invitation is written only to an explicitly named private file, never stdout.
        await writeFile(
            resolve(output),
            JSON.stringify(
                {
                    inviteId: invite.id,
                    userId: invite.userId,
                    url: `${origin.origin}/bot/invite/${invite.token}`,
                },
                null,
                2,
            ) + "\n",
            { mode: 0o600, flag: "wx" },
        );
        console.log(
            `Invitation saved privately. Allow bridge user ID ${invite.userId} for bot ${botId} before sharing the link. Invitation ID: ${invite.id}.`,
        );
        await store.close();
        return;
    }
    if (command === "revoke" || command === "mark-approved") {
        if (args[0] === undefined) throw new Error("Provide the invitation ID to revoke.");
        if (command === "mark-approved") await store.approve(args[0]);
        else await store.revoke(args[0]);
        await store.close();
        console.log(
            command === "mark-approved"
                ? "Invitation enabled after owner allowlist approval."
                : "Invitation and its guest session revoked.",
        );
        return;
    }
    if (command === "reports") {
        console.log(JSON.stringify(await store.reports(), null, 2));
        await store.close();
        return;
    }
    if (command !== "serve") throw new Error("Choose serve, invite, revoke, or reports.");
    const [registryFile, portText = "8787"] = args;
    if (registryFile === undefined || !/^\d{1,5}$/.test(portText) || Number(portText) > 65_535)
        throw new Error("Usage: start serve <state> <private registry JSON file> [localhost port]");
    const registry: unknown = JSON.parse(await readFile(registryFile, "utf8"));
    if (!Value.Check(registrySchema, registry)) throw new Error("The export registry is invalid.");
    const exports = await Promise.all(
        registry.exports.map(async (item) => {
            const url = new URL(item.connectUrl);
            if (
                !(
                    url.protocol === "ws+unix:" ||
                    url.protocol === "wss:" ||
                    (url.protocol === "ws:" &&
                        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
                )
            )
                throw new Error(
                    "Use the daemon Unix socket, local WebSocket, or a secure WebSocket URL.",
                );
            return {
                botId: item.botId,
                connectUrl: item.connectUrl,
                bridgeToken: (await readFile(item.tokenFile, "utf8")).trim(),
            };
        }),
    );
    let stopping = false;
    const stop = async () => {
        if (stopping) return;
        stopping = true;
        await gateway.stop();
        await store.close();
    };
    const gateway = createGuestServer({
        store,
        exports,
        ...(registry.trustedProxyAddress === undefined
            ? {}
            : { trustedProxyAddress: registry.trustedProxyAddress }),
        fatal(error) {
            console.error(error.message);
        },
    });
    await new Promise<void>((resolve, reject) => {
        gateway.server.once("error", reject);
        gateway.server.listen(Number(portText), "127.0.0.1", resolve);
    });
    gateway.start();
    console.log(`Invitation gateway listening on localhost port ${portText}.`);
    process.once("SIGINT", () => {
        void stop();
    });
    process.once("SIGTERM", () => {
        void stop();
    });
}

void main().catch(() => {
    // Configuration errors may contain credentials in paths or URLs. Keep diagnostics fixed.
    console.error(
        "Could not start the invitation gateway. Check the command arguments and private configuration; see README.",
    );
    process.exitCode = 1;
});
