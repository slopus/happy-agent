import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { checkBinaryKeepAlive } from "./check-binary-keepalive.mjs";

async function main() {
    if (!process.argv[2])
        throw new Error("Usage: node scripts/smoke-bun-http.mjs <bun-executable>");
    const scratch = resolve(import.meta.dirname, "../../../.context");
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(`${scratch}/t`);
    let daemon;
    let exited;
    let output = "";
    try {
        const config = `${root}/${process.platform === "darwin" ? "Happy/Config" : "happy/config"}`;
        await mkdir(config, { recursive: true });
        await writeFile(
            `${config}/happy.toml`,
            [
                "[feature.team]",
                "enabled = true",
                'host = "127.0.0.1"',
                "port = 0",
                'workos_organization_id = "org_keepalive"',
                'owner_workos_user_id = "user_keepalive"',
            ].join("\n"),
        );
        const { publicKey, privateKey } = await generateKeyPair("RS256");
        const jwk = { ...(await exportJWK(publicKey)), kid: "keepalive", alg: "RS256", use: "sig" };
        const clientId = "client_01KZD3XE9YAFAMT0P8TD4HP73E";
        const token = await new SignJWT({
            client_id: clientId,
            org_id: "org_keepalive",
            sid: "session_keepalive",
        })
            .setProtectedHeader({ alg: "RS256", kid: "keepalive" })
            .setIssuer(`https://api.workos.com/user_management/${clientId}`)
            .setSubject("user_keepalive")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(privateKey);
        daemon = spawn(
            resolve(process.argv[2]),
            [resolve(import.meta.dirname, "bun-team-http-fixture.mjs")],
            {
                cwd: root,
                env: {
                    ...process.env,
                    HOME: root,
                    HAPPY_HOME_DIR: `${root}/.happy`,
                    HAPPY_SMOKE_JWKS: JSON.stringify({ keys: [jwk] }),
                },
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        exited = new Promise((done) => daemon.once("exit", done));
        const endpoint = await new Promise((done, reject) => {
            const timer = setTimeout(
                () => reject(new Error("The Bun HTTP daemon did not start.")),
                20_000,
            );
            const record = (chunk) => {
                output = `${output}${chunk}`.slice(-16_384);
            };
            daemon.stderr.on("data", record);
            daemon.stdout.on("data", (chunk) => {
                record(chunk);
                const match = /READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
                if (match) {
                    clearTimeout(timer);
                    done(match[1]);
                }
            });
            daemon.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            daemon.once("exit", () => {
                clearTimeout(timer);
                reject(new Error("The Bun HTTP daemon exited."));
            });
        });
        const client = new HappyAgentClient({ endpoint, token });
        const { profile } = await client.getProfile();
        await client.updateProfile(
            { name: "Keep Alive", email: "keepalive@example.test" },
            { ifMatch: profile.version },
        );
        const url = new URL(endpoint);
        await checkBinaryKeepAlive({ hostname: url.hostname, port: Number(url.port) }, token);
        const abort = new AbortController();
        const events = client.streamEvents({
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        });
        try {
            if ((await events.next()).done)
                throw new Error("The Bun HTTP event stream ended early.");
        } finally {
            abort.abort();
            await events.return(undefined);
        }
        await client.getHealth();
        process.stdout.write(
            "Bun TCP HTTP keep-alive, per-request authentication, and SSE cancellation are healthy.\n",
        );
    } catch (error) {
        if (output) process.stderr.write(output);
        throw error;
    } finally {
        if (daemon) {
            daemon.kill("SIGTERM");
            const timer = setTimeout(() => daemon.kill("SIGKILL"), 2_000);
            await exited;
            clearTimeout(timer);
        }
        await rm(root, { recursive: true, force: true });
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
