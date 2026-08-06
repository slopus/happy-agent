import { createInterface } from "node:readline/promises";

import { ensureLocalProtocolServer, type ProtocolHttpClient } from "../client/index.js";
import type { P2pPairingState } from "../protocol/index.js";

export async function runP2pPairingCommand(
    command: "invite" | "join",
    invitation?: string,
): Promise<void> {
    const { client } = await ensureLocalProtocolServer({ confirmRestart: async () => true });
    const started =
        command === "invite"
            ? await client.createP2pInvitation()
            : await client.joinP2pInvitation(requireInvitation(invitation));
    if ("invitation" in started) {
        console.log("Run this on the Rig you want to join:");
        console.log(`npm install -g @slopus/rig && rig join '${started.invitation}'`);
        console.log("");
        console.log("Waiting for the other Rig…");
    } else {
        console.log("Connecting to the inviting Rig…");
    }
    await followPairing(client, started.id);
}

async function followPairing(client: ProtocolHttpClient, id: string): Promise<void> {
    let answered = false;
    for (;;) {
        const state = await client.getP2pPairing(id);
        if (state.phase === "verifying" && !answered) {
            answered = true;
            const accept = await confirmEmojis(state);
            await client.answerP2pVerification(id, accept);
        }
        if (state.phase === "connected") {
            console.log(`Hello from ${state.peer.name}!`);
            console.log(`Connected to Rig ${state.peer.instanceId}.`);
            return;
        }
        if (state.phase === "failed" || state.phase === "expired" || state.phase === "rejected") {
            throw new Error(state.error ?? `P2P pairing ${state.phase}.`);
        }
        await wait(250);
    }
}

async function confirmEmojis(
    state: Extract<P2pPairingState, { phase: "verifying" }>,
): Promise<boolean> {
    console.log("");
    console.log(`Verify with ${state.peer.name}:`);
    console.log(state.emojis.join("  "));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await prompt.question("Do both Rigs show these exact emoji? [y/N] ");
        return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
    } finally {
        prompt.close();
    }
}

function requireInvitation(invitation: string | undefined): string {
    if (invitation === undefined || invitation.length === 0) {
        throw new Error("Usage: rig join <rig://join/...>");
    }
    return invitation;
}

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
