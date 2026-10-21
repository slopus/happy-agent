import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client, type InStatement, type Row } from "@libsql/client";
import { HttpError, type Send } from "../contracts.js";

const secret = () => randomBytes(32).toString("base64url");
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export type GuestMessage = {
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt: number;
};
export type PendingMessage = { id: string; userId: string; text: string; name: string };

/** Owns the gateway's private SQLite state; never opens a daemon database. */
export class GuestStore {
    private tail: Promise<unknown> = Promise.resolve();
    private waiting = 0;
    private constructor(private readonly db: Client) {}

    static async open(directory: string): Promise<GuestStore> {
        const path = resolve(directory);
        await mkdir(path, { recursive: true, mode: 0o700 });
        await chmod(path, 0o700);
        const db = createClient({ url: pathToFileURL(join(path, "guests.sqlite")).href });
        await db.execute("PRAGMA journal_mode=WAL");
        await db.execute("PRAGMA busy_timeout=5000");
        await db.execute(`CREATE TABLE IF NOT EXISTS invites (
            id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL UNIQUE,
            bot_id TEXT NOT NULL, bot_name TEXT NOT NULL, name TEXT NOT NULL,
            expires_at INTEGER NOT NULL, read_only INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
            session_id TEXT UNIQUE, session_hash TEXT UNIQUE, redeem_nonce_hash TEXT, redeemed_at INTEGER, session_expires_at INTEGER,
            blocked INTEGER NOT NULL DEFAULT 0, reported_at INTEGER, approved INTEGER NOT NULL DEFAULT 0)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS messages (
            cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            invite_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
            created_at INTEGER NOT NULL, local_id TEXT, delivery TEXT NOT NULL,
            UNIQUE(invite_id, local_id))`);
        await db.execute(
            "CREATE INDEX IF NOT EXISTS messages_guest ON messages(invite_id, cursor)",
        );
        await chmod(join(path, "guests.sqlite"), 0o600);
        return new GuestStore(db);
    }

    private async locked<T>(operation: () => Promise<T>): Promise<T> {
        if (this.waiting >= 256) throw new HttpError(503, "The bot is busy. Try again shortly.");
        this.waiting++;
        const result = this.tail.then(operation);
        this.tail = result.catch(() => {});
        try {
            return await result;
        } finally {
            this.waiting--;
        }
    }

    async close(): Promise<void> {
        await this.tail;
        this.db.close();
    }

    async createInvite(options: {
        botId: string;
        botName: string;
        name: string;
        expiresAt: number;
        readOnly: boolean;
    }): Promise<{ id: string; userId: string; token: string }> {
        return await this.locked(async () => {
            const now = Date.now();
            if (options.expiresAt <= now || options.expiresAt > now + 86_400_000)
                throw new Error("Invitation lifetime must be between one second and 24 hours.");
            const token = secret();
            const id = secret();
            const userId = `clip_${secret()}`;
            const tx = await this.db.transaction("write");
            try {
                await tx.execute({
                    sql: "DELETE FROM messages WHERE invite_id IN (SELECT id FROM invites WHERE COALESCE(session_expires_at,expires_at) < ?)",
                    args: [now - 86_400_000],
                });
                await tx.execute({
                    sql: "DELETE FROM invites WHERE COALESCE(session_expires_at,expires_at) < ?",
                    args: [now - 86_400_000],
                });
                const count = await tx.execute("SELECT count(*) AS count FROM invites");
                if (Number(count.rows[0]?.["count"]) >= 100)
                    throw new Error(
                        "Invitation limit reached. Wait for expired invitations to be removed.",
                    );
                await tx.execute({
                    sql: "INSERT INTO invites(id,token_hash,user_id,bot_id,bot_name,name,expires_at,read_only) VALUES(?,?,?,?,?,?,?,?)",
                    args: [
                        id,
                        digest(token),
                        userId,
                        options.botId,
                        options.botName,
                        options.name,
                        options.expiresAt,
                        options.readOnly ? 1 : 0,
                    ],
                });
                await tx.commit();
                return { id, userId, token };
            } finally {
                await tx.close();
            }
        });
    }

    async redeem(
        token: string,
        nonce: string,
        botId: string,
    ): Promise<{
        sessionId: string;
        sessionToken: string;
        botName: string;
        expiresAt: number;
        readOnly: boolean;
    }> {
        return await this.locked(async () => {
            const tx = await this.db.transaction("write");
            try {
                const result = await tx.execute({
                    sql: "SELECT * FROM invites WHERE token_hash=? AND bot_id=?",
                    args: [digest(token), botId],
                });
                const invite = this.requireActive(result.rows[0]);
                if (invite["approved"] !== 1)
                    throw new HttpError(
                        503,
                        "The owner is still preparing this invitation. Try again shortly.",
                    );
                if (invite["session_id"] !== null && invite["redeem_nonce_hash"] !== digest(nonce))
                    throw new HttpError(
                        409,
                        "This invitation has already been used. Ask the owner for a new link.",
                    );
                if (invite["session_id"] !== null) this.requireActive(invite, true);
                const sessionId =
                    invite["session_id"] === null ? secret() : String(invite["session_id"]);
                const sessionToken = secret();
                const expiresAt =
                    invite["session_id"] === null
                        ? Date.now() + 30 * 86_400_000
                        : Number(invite["session_expires_at"]);
                await tx.execute({
                    sql: "UPDATE invites SET session_id=?,session_hash=?,redeem_nonce_hash=?,redeemed_at=COALESCE(redeemed_at,?),session_expires_at=? WHERE id=?",
                    args: [
                        sessionId,
                        digest(sessionToken),
                        digest(nonce),
                        Date.now(),
                        expiresAt,
                        String(invite["id"]),
                    ],
                });
                await tx.commit();
                return {
                    sessionId,
                    sessionToken,
                    botName: String(invite["bot_name"]),
                    expiresAt,
                    readOnly: invite["read_only"] === 1,
                };
            } finally {
                await tx.close();
            }
        });
    }

    private requireActive(row: Row | undefined, session = false): Row {
        if (row === undefined || row["revoked"] === 1 || row["blocked"] === 1)
            throw new HttpError(404, "This conversation is no longer available.");
        if (Number(row[session ? "session_expires_at" : "expires_at"]) <= Date.now())
            throw new HttpError(410, "This invitation has expired.");
        return row;
    }

    private async querySession(sessionId: string, token: string, botId: string): Promise<Row> {
        const result = await this.db.execute({
            sql: "SELECT * FROM invites WHERE session_id=? AND session_hash=? AND bot_id=?",
            args: [sessionId, digest(token), botId],
        });
        return this.requireActive(result.rows[0], true);
    }

    async queryInviteBot(token: string): Promise<string> {
        return await this.locked(async () => {
            const result = await this.db.execute({
                sql: "SELECT * FROM invites WHERE token_hash=?",
                args: [digest(token)],
            });
            return String(this.requireActive(result.rows[0])["bot_id"]);
        });
    }

    async querySessionBot(sessionId: string, token: string): Promise<string> {
        return await this.locked(async () => {
            const result = await this.db.execute({
                sql: "SELECT * FROM invites WHERE session_id=? AND session_hash=?",
                args: [sessionId, digest(token)],
            });
            return String(this.requireActive(result.rows[0], true)["bot_id"]);
        });
    }

    async authorize(sessionId: string, token: string, botId: string): Promise<void> {
        await this.locked(async () => {
            await this.querySession(sessionId, token, botId);
        });
    }

    async read(
        sessionId: string,
        token: string,
        botId: string,
        after: number,
    ): Promise<{ messages: GuestMessage[]; cursor: string | null }> {
        return await this.locked(async () => {
            const invite = await this.querySession(sessionId, token, botId);
            const result = await this.db.execute({
                sql: "SELECT cursor,id,role,text,created_at FROM messages WHERE invite_id=? AND cursor>? ORDER BY cursor LIMIT 100",
                args: [String(invite["id"]), after],
            });
            return {
                messages: result.rows.map((row) => ({
                    id: String(row["id"]),
                    role: row["role"] === "user" ? "user" : "assistant",
                    text: String(row["text"]),
                    createdAt: Number(row["created_at"]),
                })),
                cursor:
                    result.rows.length === 0
                        ? after === 0
                            ? null
                            : String(after)
                        : String(result.rows.at(-1)!["cursor"]),
            };
        });
    }

    async send(sessionId: string, token: string, botId: string, message: Send): Promise<void> {
        await this.locked(async () => {
            const tx = await this.db.transaction("write");
            try {
                const found = await tx.execute({
                    sql: "SELECT * FROM invites WHERE session_id=? AND session_hash=? AND bot_id=?",
                    args: [sessionId, digest(token), botId],
                });
                const invite = this.requireActive(found.rows[0], true);
                if (invite["read_only"] === 1)
                    throw new HttpError(403, "This conversation is read only.");
                const inviteId = String(invite["id"]);
                const duplicate = await tx.execute({
                    sql: "SELECT text FROM messages WHERE invite_id=? AND local_id=?",
                    args: [inviteId, message.localId],
                });
                if (duplicate.rows.length > 0) {
                    if (duplicate.rows[0]!["text"] !== message.text)
                        throw new HttpError(409, "This message ID has already been used.");
                    return;
                }
                const count = await tx.execute({
                    sql: "SELECT count(*) AS count, sum(CASE WHEN role='user' THEN 1 ELSE 0 END) AS user_count, sum(CASE WHEN created_at > ? AND role='user' THEN 1 ELSE 0 END) AS recent FROM messages WHERE invite_id=?",
                    args: [Date.now() - 60_000, inviteId],
                });
                if (
                    Number(count.rows[0]?.["count"]) >= 200 ||
                    Number(count.rows[0]?.["user_count"]) >= 100
                )
                    throw new HttpError(
                        429,
                        "This conversation has reached its message limit. Ask the owner for a new invitation.",
                        "limit_reached",
                    );
                if (Number(count.rows[0]?.["recent"]) >= 10)
                    throw new HttpError(429, "Please wait a minute before sending more messages.");
                await tx.execute({
                    sql: "INSERT INTO messages(id,invite_id,role,text,created_at,local_id,delivery) VALUES(?,?,'user',?,?,?,'pending')",
                    args: [secret(), inviteId, message.text, Date.now(), message.localId],
                });
                await tx.commit();
            } finally {
                await tx.close();
            }
        });
    }

    async pending(botId: string): Promise<PendingMessage[]> {
        return await this.locked(async () => {
            const result = await this.db.execute({
                sql: "SELECT m.id,m.text,i.user_id,i.name FROM messages m JOIN invites i ON m.invite_id=i.id WHERE m.delivery='pending' AND i.bot_id=? AND i.revoked=0 AND i.blocked=0 AND i.read_only=0 AND i.session_expires_at>? ORDER BY m.cursor LIMIT 32",
                args: [botId, Date.now()],
            });
            return result.rows.map((row) => ({
                id: String(row["id"]),
                userId: String(row["user_id"]),
                text: String(row["text"]),
                name: String(row["name"]),
            }));
        });
    }

    async acknowledge(id: string): Promise<void> {
        await this.locked(async () => {
            await this.db.execute({
                sql: "UPDATE messages SET delivery='acked' WHERE id=? AND role='user'",
                args: [id],
            });
        });
    }

    async reject(id: string): Promise<void> {
        await this.locked(async () => {
            const tx = await this.db.transaction("write");
            try {
                await tx.execute({
                    sql: `INSERT OR IGNORE INTO messages(id,invite_id,role,text,created_at,delivery)
                    SELECT ?,m.invite_id,'assistant','This message could not be delivered.',?,'acked'
                    FROM messages m JOIN invites i ON i.id=m.invite_id WHERE m.id=? AND m.role='user'
                    AND i.revoked=0 AND i.blocked=0 AND i.session_expires_at>?
                    AND (SELECT count(*) FROM messages history WHERE history.invite_id=i.id)<200`,
                    args: [`reject_${id}`, Date.now(), id, Date.now()],
                });
                await tx.execute({
                    sql: "UPDATE messages SET delivery='rejected' WHERE id=? AND role='user'",
                    args: [id],
                });
                await tx.commit();
            } finally {
                await tx.close();
            }
        });
    }

    async reply(
        botId: string,
        frame: { seq: number; userId: string; chatId: string; text?: string },
    ): Promise<void> {
        await this.locked(async () => {
            if (frame.userId !== frame.chatId) return;
            // A conditional insert makes revocation and reply delivery one SQLite boundary.
            await this.db.execute({
                sql: `INSERT OR IGNORE INTO messages(id,invite_id,role,text,created_at,delivery)
                    SELECT ?,i.id,'assistant',?,?,'acked' FROM invites i
                    WHERE i.user_id=? AND i.bot_id=? AND i.session_id IS NOT NULL
                    AND i.revoked=0 AND i.blocked=0 AND i.session_expires_at>?
                    AND (SELECT count(*) FROM messages m WHERE m.invite_id=i.id)<200`,
                args: [
                    `reply_${frame.userId}_${frame.seq}`,
                    frame.text === undefined
                        ? "The bot shared a file. Files are not available in this chat."
                        : frame.text.length > 32_000
                          ? `${frame.text.slice(0, 31_950).replace(/[\uD800-\uDBFF]$/u, "")}\n[Message shortened.]`
                          : frame.text,
                    Date.now(),
                    frame.userId,
                    botId,
                    Date.now(),
                ],
            });
        });
    }

    async revoke(inviteId: string): Promise<void> {
        await this.locked(async () => {
            await this.db.execute({
                sql: "UPDATE invites SET revoked=1 WHERE id=?",
                args: [inviteId],
            });
        });
    }

    async approve(inviteId: string): Promise<void> {
        await this.locked(async () => {
            await this.db.execute({
                sql: "UPDATE invites SET approved=1 WHERE id=? AND revoked=0",
                args: [inviteId],
            });
        });
    }

    async abuse(
        sessionId: string,
        token: string,
        botId: string,
        action: "block" | "report",
    ): Promise<void> {
        await this.locked(async () => {
            const invite = await this.querySession(sessionId, token, botId);
            const statement: InStatement =
                action === "block"
                    ? {
                          sql: "UPDATE invites SET blocked=1 WHERE id=?",
                          args: [String(invite["id"])],
                      }
                    : {
                          sql: "UPDATE invites SET reported_at=? WHERE id=?",
                          args: [Date.now(), String(invite["id"])],
                      };
            await this.db.execute(statement);
        });
    }

    async reports(): Promise<{ inviteId: string; reportedAt: number }[]> {
        return await this.locked(async () => {
            const result = await this.db.execute(
                "SELECT id,reported_at FROM invites WHERE reported_at IS NOT NULL ORDER BY reported_at DESC LIMIT 100",
            );
            return result.rows.map((row) => ({
                inviteId: String(row["id"]),
                reportedAt: Number(row["reported_at"]),
            }));
        });
    }
}
