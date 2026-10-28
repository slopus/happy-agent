// End-to-end check of one invitation through the public origin. Prints no credentials.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const invite = JSON.parse(readFileSync(process.argv[2], "utf8"));
const url = new URL(invite.url);
const origin = url.origin;
const token = url.pathname.split("/").at(-1);
const redeemed = await fetch(`${origin}/v1/bot-invites/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
        token,
        redeemNonce: randomBytes(32).toString("base64url"),
        displayName: "Verifier",
    }),
});
console.log("redeem", redeemed.status);
const session = await redeemed.json();
console.log(
    "bot",
    session.botName,
    "readOnly",
    session.readOnly,
    "expiresAt",
    new Date(session.expiresAt).toISOString(),
);
const messages = `${origin}/v1/bot-guest/sessions/${session.sessionId}/messages`;
const auth = {
    authorization: `Bearer ${session.sessionToken}`,
    "content-type": "application/json",
};
const marker = `CLIP_OK_${randomBytes(4).toString("hex")}`;
const sent = await fetch(messages, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
        localId: "verify1",
        text: `Reply with exactly ${marker} and nothing else.`,
    }),
});
console.log("send", sent.status);
let cursor = null;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
    const page = await fetch(`${messages}?wait=25${cursor === null ? "" : `&after=${cursor}`}`, {
        headers: auth,
    });
    if (page.status !== 200) {
        console.log("poll", page.status, await page.text());
        process.exit(1);
    }
    const body = await page.json();
    cursor = body.cursor;
    for (const message of body.messages)
        console.log(
            `${message.role} ${message.senderName} isMine=${message.isMine}: ${message.text.slice(0, 200)}`,
        );
    if (body.messages.some((message) => message.role === "assistant")) {
        console.log(
            "status",
            body.status,
            body.messages.some((m) => m.text.includes(marker)) ? "MARKER_OK" : "NO_MARKER",
        );
        process.exit(0);
    }
}
console.log("timed out waiting for reply");
process.exit(1);
