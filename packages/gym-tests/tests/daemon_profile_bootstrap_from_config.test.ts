import { createGym } from "@slopus/happy-terminal-gym";
import { describe, expect, it } from "vitest";

describe("standalone profile configuration bootstrap", () => {
    it("satisfies profile onboarding on first startup without a profile mutation and survives restart", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: {
                HAPPY_HOME_DIR: "/tmp/happy",
            },
            entrypoint: ["bash", "/workspace/bootstrap.sh"],
            files: {
                "config/happy.toml":
                    '[profile]\nname = "Ada Lovelace"\nemail = "ada@example.test"\n',
                "bootstrap.sh": bootstrapScript,
                "check-profile.mjs": checkProfile,
            },
            inference: [],
            startupText: "PROFILE_BOOTSTRAP_COMPLETE",
            timeoutMs: 60_000,
        });
        try {
            const screen = await gym.terminal.snapshot();
            expect(screen.text).toContain("Profile onboarding satisfied from config");
            expect(screen.text).toContain("Profile identity and version survived restart");
        } finally {
            await gym.dispose();
        }
    }, 120_000);
});

const bootstrapScript = String.raw`#!/usr/bin/env bash
set -euo pipefail
agent() { node /app/happy-agent/dist/cli.js "$@"; }
install -d -m 0700 /tmp/happy/config
install -m 0600 /workspace/config/happy.toml /tmp/happy/config/happy.toml
agent start
node /workspace/check-profile.mjs first
agent reload
node /workspace/check-profile.mjs restarted
agent stop
echo PROFILE_BOOTSTRAP_COMPLETE
read -r
`;

// Only read requests: the profile must be initialized by startup's config records.
const checkProfile = String.raw`
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
const token = (await readFile('/tmp/happy/agent/token', 'utf8')).trim();
async function get(path) {
    return await new Promise((resolve, reject) => {
        const req = http.get({
            socketPath: '/tmp/happy/agent/server.sock', path,
            headers: { authorization: 'Bearer ' + token },
        }, (response) => {
            let contents = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { contents += chunk; });
            response.on('end', () => {
                try { assert.equal(response.statusCode, 200); resolve(JSON.parse(contents)); }
                catch (error) { reject(error); }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('Profile check timed out.')));
    });
}
const { profile } = await get('/v0/profile');
assert.equal(profile.name, 'Ada Lovelace');
assert.equal(profile.email, 'ada@example.test');
assert.equal((await get('/v0/onboarding')).steps.profile.done, true);
if (process.argv[2] === 'first') {
    await writeFile('/workspace/profile-baseline.json', JSON.stringify(profile), { mode: 0o600 });
    console.log('Profile onboarding satisfied from config');
} else {
    assert.deepEqual(profile, JSON.parse(await readFile('/workspace/profile-baseline.json', 'utf8')));
    console.log('Profile identity and version survived restart');
}
`;
