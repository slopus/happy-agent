import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGym, type Gym } from "@slopus/happy-terminal-gym";

const running = new Set<Gym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("native Happy Agent lifecycle", () => {
    it("uses original commands and keeps authentication across reload", async () => {
        const binaryPath =
            process.env.HAPPY_NATIVE_GYM_BINARY ??
            fileURLToPath(
                new URL(
                    `../../happy-agent/dist/bin/happy-agent-linux-${process.arch}`,
                    import.meta.url,
                ),
            );
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["bash", "/workspace/lifecycle.sh"],
            files: {
                "happy-agent": { content: readFileSync(binaryPath), mode: 0o755 },
                "lifecycle.sh": driver,
                "client.mjs": client,
            },
            startupText: "Native lifecycle ready",
            inference: [],
        });
        running.add(gym);
        for (const [command, visible] of [
            ["start", "Daemon is running at"],
            ["health", "Authenticated native health verified"],
            ["drain", "The daemon is drained and still running."],
            ["reload", "Reloaded native daemon retained its token"],
            ["detach", "Detached native reload replaced the daemon and retained its token"],
            ["stop", "Daemon stopped."],
            ["status", "Daemon is not running."],
        ]) {
            gym.terminal.type(command!);
            gym.terminal.press("enter");
            const screen = await gym.terminal.waitForText(visible!, 30_000);
            expect(screen.text).toContain(visible);
        }
        expect(gym.inference.requests).toHaveLength(0);
    }, 120_000);
});

const driver = String.raw`#!/usr/bin/env bash
set -euo pipefail
echo 'Native lifecycle ready'
while IFS= read -r action; do
    case "$action" in
        start|status|stop|kill|drain) /workspace/happy-agent "$action" ;;
        health) node /workspace/client.mjs ;;
        reload)
            previous_token=$(cat /home/happy-terminal/.happy/agent/token)
            /workspace/happy-agent reload
            test "$previous_token" = "$(cat /home/happy-terminal/.happy/agent/token)"
            echo 'Reloaded native daemon retained its token'
            ;;
        detach)
            previous_pid=$(cat /home/happy-terminal/.happy/agent/daemon.pid)
            /workspace/happy-agent reload --detach
            node /workspace/client.mjs detached "$previous_pid"
            ;;
        *) echo 'Choose start, health, drain, reload, stop, or status.' ;;
    esac
done
`;

const client = String.raw`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire('/app/packages/happy-terminal/package.json');
const { HappyAgentClient } = await import(require.resolve('@slopus/happy-agent-client'));
const socketPath = '/home/happy-terminal/.happy/agent/server.sock';
const token = readFileSync('/home/happy-terminal/.happy/agent/token','utf8').trim();
const socketFetch = (input, init = {}) => new Promise((resolve,reject) => {
    const url = new URL(input);
    const req = request({socketPath,path:url.pathname+url.search,method:init.method ?? 'GET',headers:Object.fromEntries(new Headers(init.headers))},res => {
        const chunks=[];
        res.on('data',chunk => chunks.push(chunk));
        res.on('error',reject);
        res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });
    req.on('error',reject);
    req.end(init.body);
});
const client = new HappyAgentClient({endpoint:'http://happy',token,fetch:socketFetch});
if (process.argv[2] === 'detached') {
    const deadline = Date.now() + 30_000;
    while (!readFileSync('/home/happy-terminal/.happy/agent/reload.log', 'utf8').includes('Daemon is running at')) {
        assert.ok(Date.now() < deadline, 'detached replacement became ready');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(readFileSync('/home/happy-terminal/.happy/agent/token','utf8').trim(), token);
    assert.notEqual(readFileSync('/home/happy-terminal/.happy/agent/daemon.pid','utf8').trim(), process.argv[3]);
    console.log('Detached native reload replaced the daemon and retained its token');
}
const health = await client.getHealth();
assert.equal(health.ready,true);
assert.equal(health.version.protocol,26);
const unauthenticated = await socketFetch('http://happy/v0/authentication');
assert.deepEqual(await unauthenticated.json(),{authenticated:false,userId:null,methods:[]});
const rejected = await socketFetch('http://happy/v0/health');
assert.equal(rejected.status,401);
console.log('Authenticated native health verified');
`;
