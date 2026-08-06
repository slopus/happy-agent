import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ensureLocalProtocolServer } from "../client/index.js";
import { getRigHome } from "../config/index.js";
import {
    NACL_BOX_SECRET_KEY_BYTES,
    nobleBoxKeyPairFromSecretKey,
    type NobleBoxKeyPair,
} from "../crypto/nobleNaCl.js";
import { readPackageVersion } from "../readPackageVersion.js";
import { decryptHappyAuthBundle } from "./happyEncryption.js";
import { getHappyPaths } from "./getHappyPaths.js";
import { renderHappyQrCode } from "./renderHappyQrCode.js";
import { resolveHappyHome } from "./resolveHappyHome.js";
import { resolveHappyServerUrl } from "./resolveHappyServerUrl.js";
import type { HappyStoredCredentials } from "./types.js";
import { writeHappyJsonFile } from "./writeHappyJsonFile.js";

const REQUEST_TIMEOUT_MS = 15_000;

export interface RunHappyAuthCommandOptions {
    environment?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    homeDirectory?: string;
    keyPair?: NobleBoxKeyPair;
    onAuthenticated?: () => Promise<void>;
    pollIntervalMs?: number;
    renderQrCode?: (url: string) => Promise<void>;
    rigHome?: string;
}

export async function runHappyAuthCommand(
    options: RunHappyAuthCommandOptions = {},
): Promise<boolean> {
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? homedir();
    const rigHome = options.rigHome ?? getRigHome(environment, homeDirectory);
    const paths = getHappyPaths(rigHome);
    const serverUrl = await resolveServerUrl(environment, homeDirectory, paths.settingsPath);
    const request = options.fetch ?? fetch;
    const keyPair =
        options.keyPair ??
        nobleBoxKeyPairFromSecretKey(new Uint8Array(randomBytes(NACL_BOX_SECRET_KEY_BYTES)));
    const publicKey = Buffer.from(keyPair.publicKey).toString("base64");
    const authenticationUrl = `happy://terminal?${Buffer.from(keyPair.publicKey).toString("base64url")}`;
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);

    try {
        await requestAuthentication(request, serverUrl, publicKey, controller.signal);
        console.log("Scan this QR code with the Happy mobile app:\n");
        await (options.renderQrCode ?? renderHappyQrCode)(authenticationUrl);
        console.log(`\nOr open this URL in Happy:\n${authenticationUrl}\n`);
        process.stdout.write("Waiting for authentication…");

        while (!controller.signal.aborted) {
            try {
                await delay(options.pollIntervalMs ?? 1_000, controller.signal);
            } catch (error) {
                if (controller.signal.aborted) break;
                throw error;
            }
            const response = await requestAuthentication(
                request,
                serverUrl,
                publicKey,
                controller.signal,
            );
            if (!isRecord(response) || response.state !== "authorized") continue;
            if (typeof response.token !== "string" || typeof response.response !== "string") {
                throw new Error("Happy returned invalid authentication credentials.");
            }
            const plaintext = decryptHappyAuthBundle(
                new Uint8Array(Buffer.from(response.response, "base64")),
                keyPair.secretKey,
            );
            const stored = decodeAuthorizedCredentials(response.token, plaintext);
            await writeHappyJsonFile(paths.credentialsPath, stored);
            const settings = await readRecord(paths.settingsPath);
            await writeHappyJsonFile(paths.settingsPath, { ...settings, serverUrl });
            process.stdout.write("\rAuthentication successful.                 \n");
            await (options.onAuthenticated ?? reloadRunningDaemon)();
            return true;
        }
        process.stdout.write("\nAuthentication cancelled.\n");
        return false;
    } catch (error) {
        if (controller.signal.aborted) {
            process.stdout.write("\nAuthentication cancelled.\n");
            return false;
        }
        throw error;
    } finally {
        process.off("SIGINT", onInterrupt);
    }
}

async function requestAuthentication(
    request: typeof fetch,
    serverUrl: string,
    publicKey: string,
    cancellationSignal: AbortSignal,
): Promise<unknown> {
    const response = await request(`${serverUrl}/v1/auth/request`, {
        body: JSON.stringify({ publicKey, supportsV2: true }),
        headers: {
            "Content-Type": "application/json",
            "X-Happy-Client": `rig/${readPackageVersion()}`,
        },
        method: "POST",
        signal: AbortSignal.any([cancellationSignal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) {
        throw new Error(`Happy authentication returned HTTP ${String(response.status)}.`);
    }
    return response.json() as Promise<unknown>;
}

function decodeAuthorizedCredentials(
    token: string,
    plaintext: Uint8Array | undefined,
): HappyStoredCredentials {
    if (plaintext?.length === 32) {
        return { secret: Buffer.from(plaintext).toString("base64"), token };
    }
    if (plaintext?.length === 33 && plaintext[0] === 0) {
        return {
            encryption: {
                machineKey: randomBytes(32).toString("base64"),
                publicKey: Buffer.from(plaintext.slice(1)).toString("base64"),
            },
            token,
        };
    }
    throw new Error("Happy returned an unreadable authentication response.");
}

async function reloadRunningDaemon(): Promise<void> {
    const connection = await ensureLocalProtocolServer({ confirmRestart: async () => true });
    const response = await connection.client.reloadHappy();
    if (!response.enabled) throw new Error("The Rig daemon could not load the Happy credentials.");
}

async function resolveServerUrl(
    environment: NodeJS.ProcessEnv,
    homeDirectory: string,
    targetSettingsPath: string,
): Promise<string> {
    const sourceHome = resolveHappyHome(environment, homeDirectory);
    const sourceSettings = await readRecord(join(sourceHome, "settings.json"));
    const targetSettings = await readRecord(targetSettingsPath);
    const sourceServerUrl = readString(sourceSettings.serverUrl);
    const targetServerUrl = readString(targetSettings.serverUrl);
    return resolveHappyServerUrl({
        environment,
        ...(sourceServerUrl === undefined ? {} : { sourceServerUrl }),
        ...(targetServerUrl === undefined ? {} : { targetServerUrl }),
    });
}

async function readRecord(path: string): Promise<Record<string, unknown>> {
    try {
        const value = JSON.parse(await readFile(path, "utf8")) as unknown;
        return isRecord(value) ? value : {};
    } catch {
        return {};
    }
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
