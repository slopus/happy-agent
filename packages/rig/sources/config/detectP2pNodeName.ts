import { execFileSync } from "node:child_process";
import { hostname as readHostname } from "node:os";
import { Value } from "@sinclair/typebox/value";

import { p2pPeerNameSchema } from "../p2p/P2pPeer.js";

const FALLBACK_NODE_NAME = "Rig";
const MACOS_NAME_TIMEOUT_MS = 1_000;

export interface DetectP2pNodeNameOptions {
    hostname?: () => string;
    platform?: NodeJS.Platform;
    readMacComputerName?: () => string;
}

export function detectP2pNodeName(options: DetectP2pNodeNameOptions = {}): string {
    if ((options.platform ?? process.platform) === "darwin") {
        const computerName = readValidName(options.readMacComputerName ?? readMacComputerName);
        if (computerName !== undefined) return computerName;
    }
    return readValidName(options.hostname ?? readHostname) ?? FALLBACK_NODE_NAME;
}

function readMacComputerName(): string {
    return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: MACOS_NAME_TIMEOUT_MS,
        windowsHide: true,
    });
}

function readValidName(read: () => string): string | undefined {
    try {
        const value = read().trim();
        return Value.Check(p2pPeerNameSchema, value) ? value : undefined;
    } catch {
        return undefined;
    }
}
