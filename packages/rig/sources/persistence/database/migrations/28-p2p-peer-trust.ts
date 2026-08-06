import { sql } from "drizzle-orm";

import type { SessionDatabase } from "../openSessionDatabase.js";

export function p2pPeerTrust(database: SessionDatabase): void {
    database.run(
        sql.raw(`CREATE TABLE p2p_peers (
            instance_id TEXT NOT NULL PRIMARY KEY,
            public_key TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            bindings_json TEXT NOT NULL,
            connections_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
        )`),
    );
    database.run(
        sql.raw(`CREATE TABLE p2p_peer_pairings (
            pairing_id TEXT NOT NULL PRIMARY KEY,
            instance_id TEXT NOT NULL,
            public_key TEXT NOT NULL,
            name TEXT NOT NULL,
            bindings_json TEXT NOT NULL,
            connections_json TEXT NOT NULL,
            assign_primary INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('prepared', 'local_ready', 'confirmed')),
            expires_at_ms INTEGER NOT NULL
        )`),
    );
}
