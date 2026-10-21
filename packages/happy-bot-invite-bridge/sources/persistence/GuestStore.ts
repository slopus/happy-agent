import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client, type Row } from "@libsql/client";
import { Value } from "@sinclair/typebox/value";
import { displayNameSchema, HttpError, maxMembersSchema, type Send } from "../contracts.js";
import { formatGroupMessage } from "../formatGroupMessage.js";

const secret = () => randomBytes(32).toString("base64url");
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export type GuestMessage = {
    id: string;
    role: "user" | "assistant";
    text: string;
    createdAt: number;
    senderName: string;
    isMine: boolean;
};
export type PendingMessage = { id: string; userId: string; text: string; name: string };

/** Generation 3 owns member credentials and one shared chat and bridge guest per invite. */
export class GuestStore {
    private tail: Promise<unknown> = Promise.resolve();
    private waiting = 0;
    private constructor(private readonly db: Client) {}

    static async open(directory: string): Promise<GuestStore> {
        const path = resolve(directory);
        await mkdir(path, { recursive: true, mode: 0o700 });
        await chmod(path, 0o700);
        const file = join(path, "guests-v3.sqlite");
        const db = createClient({ url: pathToFileURL(file).href });
        await db.execute("PRAGMA busy_timeout=5000");
        await db.execute("PRAGMA journal_mode=WAL");
        await db.execute(`CREATE TABLE IF NOT EXISTS invites (
            id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL, bot_name TEXT NOT NULL,
            group_user_id TEXT NOT NULL UNIQUE, group_label TEXT NOT NULL,
            expires_at INTEGER NOT NULL, read_only INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
            approved INTEGER NOT NULL DEFAULT 0, max_members INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS members (
            id TEXT PRIMARY KEY, invite_id TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL,
            name TEXT, session_id TEXT UNIQUE, session_hash TEXT UNIQUE, nonce_hash TEXT,
            joined_at INTEGER, last_active INTEGER, session_expires_at INTEGER, read_only INTEGER NOT NULL,
            revoked INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, reported_at INTEGER,
            UNIQUE(invite_id,nonce_hash))`);
        await db.execute(`CREATE TABLE IF NOT EXISTS messages (
            cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, invite_id TEXT NOT NULL, member_id TEXT,
            role TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, local_id TEXT,
            delivery TEXT NOT NULL, UNIQUE(member_id,local_id))`);
        await db.execute(
            "CREATE INDEX IF NOT EXISTS messages_member ON messages(member_id,cursor)",
        );
        await db.execute(
            "CREATE INDEX IF NOT EXISTS messages_invite ON messages(invite_id,cursor)",
        );
        await chmod(file, 0o600);
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
        maxMembers: number;
        expiresAt: number;
        readOnly: boolean;
    }): Promise<{ id: string; userIds: string[]; groupUserId: string; token: string }> {
        if (!Value.Check(maxMembersSchema, options.maxMembers))
            throw new Error("Choose between one and twenty members.");
        return await this.locked(async () => {
            const now = Date.now();
            if (options.expiresAt <= now || options.expiresAt > now + 86_400_000)
                throw new Error("Invitation lifetime must be between one second and 24 hours.");
            const token = secret();
            const id = secret();
            const groupUserId = `clip_group_${secret()}`;
            const userIds = Array.from({ length: options.maxMembers }, () => `clip_${secret()}`);
            const tx = await this.db.transaction("write");
            try {
                // Prune the whole invitation only after every possible member session expired.
                const cutoff = now - 31 * 86_400_000;
                await tx.execute({
                    sql: "DELETE FROM messages WHERE invite_id IN (SELECT id FROM invites WHERE expires_at<?)",
                    args: [cutoff],
                });
                await tx.execute({
                    sql: "DELETE FROM members WHERE invite_id IN (SELECT id FROM invites WHERE expires_at<?)",
                    args: [cutoff],
                });
                await tx.execute({ sql: "DELETE FROM invites WHERE expires_at<?", args: [cutoff] });
                const count = await tx.execute("SELECT count(*) AS count FROM members");
                if (Number(count.rows[0]?.["count"]) + options.maxMembers > 100)
                    throw new Error(
                        "The gateway's 100-member limit is reached. Wait for expired invitations to be removed.",
                    );
                await tx.execute({
                    sql: "INSERT INTO invites(id,token_hash,bot_id,bot_name,expires_at,read_only,max_members,group_user_id,group_label) VALUES(?,?,?,?,?,?,?,?,?)",
                    args: [
                        id,
                        digest(token),
                        options.botId,
                        options.botName,
                        options.expiresAt,
                        options.readOnly ? 1 : 0,
                        options.maxMembers,
                        groupUserId,
                        "App Clip group",
                    ],
                });
                for (const userId of userIds)
                    await tx.execute({
                        sql: "INSERT INTO members(id,invite_id,user_id,bot_id,read_only) VALUES(?,?,?,?,?)",
                        args: [secret(), id, userId, options.botId, options.readOnly ? 1 : 0],
                    });
                await tx.commit();
                return { id, userIds, groupUserId, token };
            } finally {
                await tx.close();
            }
        });
    }

    async redeem(
        token: string,
        nonce: string,
        botId: string,
        suppliedName: string,
    ): Promise<{
        sessionId: string;
        sessionToken: string;
        memberId: string;
        displayName: string;
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
                const inviteId = String(invite["id"]);
                const nonceHash = digest(nonce);
                const existing = await tx.execute({
                    sql: "SELECT * FROM members WHERE invite_id=? AND nonce_hash=?",
                    args: [inviteId, nonceHash],
                });
                const sessionToken = secret();
                let member: Row;
                if (existing.rows[0] !== undefined) {
                    member = this.requireActive(existing.rows[0], true);
                    await tx.execute({
                        sql: "UPDATE members SET session_hash=?,last_active=? WHERE id=?",
                        args: [digest(sessionToken), Date.now(), String(member["id"])],
                    });
                } else {
                    // Only a new claim accepts a name. Recovery ignores supplied display data.
                    // Reject invisible/control data before whitespace normalization hides it.
                    const normalized = suppliedName.normalize("NFC");
                    const displayName = normalized.replace(/\s+/gu, " ").trim();
                    if (
                        /[\p{C}\p{Zl}\p{Zp}]/u.test(normalized) ||
                        !Value.Check(displayNameSchema, displayName)
                    )
                        throw new HttpError(
                            400,
                            "Enter a name of 1–40 characters using letters, numbers, spaces, or simple name punctuation.",
                            "invalid_name",
                        );
                    if (Number(invite["used"]) >= Number(invite["max_members"]))
                        throw new HttpError(410, "This invite is full.", "invite_full");
                    const recent = await tx.execute({
                        sql: "SELECT count(*) AS count FROM members WHERE invite_id=? AND joined_at>?",
                        args: [inviteId, Date.now() - 60_000],
                    });
                    if (Number(recent.rows[0]?.["count"]) >= Number(invite["max_members"]))
                        throw new HttpError(
                            429,
                            "Please wait a minute before joining this invitation.",
                            "rate_limited",
                        );
                    // A revoked/expired member's seat is never available again.
                    const claimed = await tx.execute({
                        sql: `UPDATE members SET name=?,nonce_hash=?,session_id=?,session_hash=?,joined_at=?,last_active=?,session_expires_at=?
                            WHERE id=(SELECT id FROM members WHERE invite_id=? AND joined_at IS NULL AND revoked=0 AND blocked=0 ORDER BY id LIMIT 1)
                            AND joined_at IS NULL AND revoked=0
                            AND EXISTS(SELECT 1 FROM invites WHERE id=? AND used<max_members)`,
                        args: [
                            displayName,
                            nonceHash,
                            secret(),
                            digest(sessionToken),
                            Date.now(),
                            Date.now(),
                            Date.now() + 30 * 86_400_000,
                            inviteId,
                            inviteId,
                        ],
                    });
                    if (claimed.rowsAffected !== 1)
                        throw new HttpError(410, "This invite is full.", "invite_full");
                    await tx.execute({
                        sql: "UPDATE invites SET used=used+1 WHERE id=? AND used<max_members",
                        args: [inviteId],
                    });
                    const fresh = await tx.execute({
                        sql: "SELECT * FROM members WHERE invite_id=? AND nonce_hash=?",
                        args: [inviteId, nonceHash],
                    });
                    member = this.requireActive(fresh.rows[0], true);
                }
                await tx.commit();
                return {
                    sessionId: String(member["session_id"]),
                    sessionToken,
                    memberId: String(member["id"]),
                    displayName: String(member["name"]),
                    botName: String(invite["bot_name"]),
                    expiresAt: Number(member["session_expires_at"]),
                    readOnly: member["read_only"] === 1,
                };
            } finally {
                await tx.close();
            }
        });
    }

    private requireActive(row: Row | undefined, session = false): Row {
        if (
            row === undefined ||
            row["revoked"] === 1 ||
            row["blocked"] === 1 ||
            row["invite_revoked"] === 1
        )
            throw new HttpError(404, "This conversation is no longer available.");
        if (Number(row[session ? "session_expires_at" : "expires_at"]) <= Date.now())
            throw new HttpError(410, "This invitation has expired.", "expired");
        return row;
    }

    private async querySession(sessionId: string, token: string, botId: string): Promise<Row> {
        const result = await this.db.execute({
            sql: "SELECT m.*,i.revoked AS invite_revoked FROM members m JOIN invites i ON i.id=m.invite_id WHERE m.session_id=? AND m.session_hash=? AND m.bot_id=?",
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
                sql: "SELECT m.*,i.revoked AS invite_revoked FROM members m JOIN invites i ON i.id=m.invite_id WHERE m.session_id=? AND m.session_hash=?",
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
            const member = await this.querySession(sessionId, token, botId);
            const result = await this.db.execute({
                sql: "SELECT h.cursor,h.id,h.role,h.text,h.created_at,h.member_id,m.name,i.bot_name FROM messages h JOIN invites i ON i.id=h.invite_id LEFT JOIN members m ON m.id=h.member_id WHERE h.invite_id=? AND h.cursor>? ORDER BY h.cursor LIMIT 100",
                args: [String(member["invite_id"]), after],
            });
            await this.db.execute({
                sql: "UPDATE members SET last_active=? WHERE id=?",
                args: [Date.now(), String(member["id"])],
            });
            return {
                messages: result.rows.map((row) => ({
                    id: String(row["id"]),
                    role: row["role"] === "user" ? "user" : "assistant",
                    text: String(row["text"]),
                    createdAt: Number(row["created_at"]),
                    senderName:
                        row["role"] === "user" ? String(row["name"]) : String(row["bot_name"]),
                    isMine: row["role"] === "user" && row["member_id"] === member["id"],
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
                    sql: "SELECT m.*,i.revoked AS invite_revoked FROM members m JOIN invites i ON i.id=m.invite_id WHERE m.session_id=? AND m.session_hash=? AND m.bot_id=?",
                    args: [sessionId, digest(token), botId],
                });
                const member = this.requireActive(found.rows[0], true);
                if (member["read_only"] === 1)
                    throw new HttpError(403, "This conversation is read only.");
                const memberId = String(member["id"]);
                const inviteId = String(member["invite_id"]);
                const duplicate = await tx.execute({
                    sql: "SELECT text FROM messages WHERE member_id=? AND local_id=?",
                    args: [memberId, message.localId],
                });
                if (duplicate.rows.length > 0) {
                    if (duplicate.rows[0]!["text"] !== message.text)
                        throw new HttpError(409, "This message ID has already been used.");
                    return;
                }
                const count = await tx.execute({
                    sql: "SELECT count(*) AS count,sum(CASE WHEN role='user' THEN 1 ELSE 0 END) AS user_count,sum(CASE WHEN created_at>? AND role='user' THEN 1 ELSE 0 END) AS recent FROM messages WHERE member_id=?",
                    args: [Date.now() - 60_000, memberId],
                });
                if (Number(count.rows[0]?.["user_count"]) >= 100)
                    throw new HttpError(
                        429,
                        "This conversation has reached its message limit. Ask the owner for a new invitation.",
                        "limit_reached",
                    );
                if (Number(count.rows[0]?.["recent"]) >= 10)
                    throw new HttpError(429, "Please wait a minute before sending more messages.");
                const group = await tx.execute({
                    sql: "SELECT count(*) AS total,sum(CASE WHEN role='user' THEN 1 ELSE 0 END) AS users,sum(CASE WHEN role='user' AND created_at>? THEN 1 ELSE 0 END) AS recent FROM messages WHERE invite_id=?",
                    args: [Date.now() - 60_000, inviteId],
                });
                if (
                    Number(group.rows[0]?.["total"]) >= 1000 ||
                    Number(group.rows[0]?.["users"]) >= 500
                )
                    throw new HttpError(
                        429,
                        "This group has reached its message limit. Ask the owner for a new invitation.",
                        "limit_reached",
                    );
                if (Number(group.rows[0]?.["recent"]) >= 30)
                    throw new HttpError(
                        429,
                        "Please wait a minute before sending more messages to this group.",
                        "rate_limited",
                    );
                await tx.execute({
                    sql: "INSERT INTO messages(id,invite_id,member_id,role,text,created_at,local_id,delivery) VALUES(?,?,?,'user',?,?,?,'pending')",
                    args: [secret(), inviteId, memberId, message.text, Date.now(), message.localId],
                });
                await tx.execute({
                    sql: "UPDATE members SET last_active=? WHERE id=?",
                    args: [Date.now(), memberId],
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
                sql: "SELECT h.id,h.text,m.id AS member_id,m.name,i.group_user_id,i.group_label FROM messages h JOIN members m ON h.member_id=m.id JOIN invites i ON i.id=m.invite_id WHERE h.delivery='pending' AND m.bot_id=? AND i.revoked=0 AND m.revoked=0 AND m.blocked=0 AND m.read_only=0 AND m.session_expires_at>? ORDER BY h.cursor LIMIT 32",
                args: [botId, Date.now()],
            });
            return result.rows.map((row) => ({
                id: String(row["id"]),
                userId: String(row["group_user_id"]),
                text: formatGroupMessage({
                    memberId: String(row["member_id"]),
                    displayName: String(row["name"]),
                    text: String(row["text"]),
                }),
                name: String(row["group_label"]),
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
                    SELECT ?,h.invite_id,'assistant','This message could not be delivered.',?,'acked'
                    FROM messages h JOIN members m ON m.id=h.member_id JOIN invites i ON i.id=m.invite_id
                    WHERE h.id=? AND h.role='user' AND i.revoked=0 AND m.revoked=0 AND m.blocked=0 AND m.session_expires_at>?
                    AND (SELECT count(*) FROM messages history WHERE history.invite_id=i.id)<1000`,
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
            await this.db.execute({
                sql: `INSERT OR IGNORE INTO messages(id,invite_id,role,text,created_at,delivery)
                SELECT ?,i.id,'assistant',?,?,'acked' FROM invites i
                WHERE i.group_user_id=? AND i.bot_id=? AND i.revoked=0
                AND EXISTS(SELECT 1 FROM members m WHERE m.invite_id=i.id AND m.session_expires_at>?)
                AND (SELECT count(*) FROM messages h WHERE h.invite_id=i.id)<1000`,
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
    async revokeMember(inviteId: string, memberId: string): Promise<void> {
        await this.locked(async () => {
            await this.db.execute({
                sql: "UPDATE members SET revoked=1 WHERE invite_id=? AND id=?",
                args: [inviteId, memberId],
            });
        });
    }
    async approve(inviteId: string, groupUserId: string): Promise<void> {
        await this.locked(async () => {
            const result = await this.db.execute({
                sql: "UPDATE invites SET approved=1 WHERE id=? AND revoked=0 AND group_user_id=?",
                args: [inviteId, groupUserId],
            });
            if (result.rowsAffected !== 1)
                throw new Error(
                    "The invitation group ID does not match. Verify its shared group ID on the daemon allowlist first.",
                );
        });
    }

    async listMembers(inviteId: string): Promise<{
        used: number;
        maxMembers: number;
        members: {
            memberId: string;
            userId: string;
            displayName: string;
            joinedAt: number;
            lastActive: number;
            revoked: boolean;
        }[];
    }> {
        return await this.locked(async () => {
            const invite = (
                await this.db.execute({
                    sql: "SELECT used,max_members FROM invites WHERE id=?",
                    args: [inviteId],
                })
            ).rows[0];
            if (invite === undefined) throw new Error("Invitation not found.");
            const rows = await this.db.execute({
                sql: "SELECT * FROM members WHERE invite_id=? AND joined_at IS NOT NULL ORDER BY joined_at,id",
                args: [inviteId],
            });
            return {
                used: Number(invite["used"]),
                maxMembers: Number(invite["max_members"]),
                members: rows.rows.map((row) => ({
                    memberId: String(row["id"]),
                    userId: String(row["user_id"]),
                    displayName: String(row["name"]),
                    joinedAt: Number(row["joined_at"]),
                    lastActive: Number(row["last_active"]),
                    revoked: row["revoked"] === 1 || row["blocked"] === 1,
                })),
            };
        });
    }

    async abuse(
        sessionId: string,
        token: string,
        botId: string,
        action: "block" | "report",
    ): Promise<void> {
        await this.locked(async () => {
            const member = await this.querySession(sessionId, token, botId);
            await this.db.execute(
                action === "block"
                    ? {
                          sql: "UPDATE members SET blocked=1 WHERE id=?",
                          args: [String(member["id"])],
                      }
                    : {
                          sql: "UPDATE members SET reported_at=? WHERE id=?",
                          args: [Date.now(), String(member["id"])],
                      },
            );
        });
    }
    async reports(): Promise<{ inviteId: string; memberId: string; reportedAt: number }[]> {
        return await this.locked(async () => {
            const result = await this.db.execute(
                "SELECT invite_id,id,reported_at FROM members WHERE reported_at IS NOT NULL ORDER BY reported_at DESC LIMIT 100",
            );
            return result.rows.map((row) => ({
                inviteId: String(row["invite_id"]),
                memberId: String(row["id"]),
                reportedAt: Number(row["reported_at"]),
            }));
        });
    }
}
