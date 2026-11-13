import type { AccountLinkStatus } from "../AccountLink.js";

/** One bounded, human-readable rendering shared by every account link tool. */
export function formatAccountLinkStatus(status: AccountLinkStatus): string {
    if (status.state === "unavailable") return status.reason;
    if (status.state === "unlinked") {
        return status.error === undefined
            ? "This computer is not linked to a Happy account."
            : `This computer is not linked to a Happy account. ${status.error}`;
    }
    if (status.state === "linking") {
        const minutes = Math.max(1, Math.round((status.expiresAt - Date.now()) / 60_000));
        return `Waiting for approval. Ask the person to open ${status.verificationUrl} while signed in to their Happy account and confirm the code ${status.userCode}. The code expires in about ${String(minutes)} minutes. Whoever approves it becomes this computer's owner.`;
    }
    const problem = status.error === undefined ? "" : ` ${status.error}`;
    if (!status.reachable) {
        return `This computer is linked to Happy account ${status.accountId} and is not reachable through the Happy Relay.${problem}`;
    }
    return status.relay === "attached"
        ? `This computer is linked to Happy account ${status.accountId} and reachable through the Happy Relay.${problem}`
        : `This computer is linked to Happy account ${status.accountId} and is connecting to the Happy Relay.${problem}`;
}
