import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { nodeNameSchema } from "@slopus/happy-agent-client";
import { Value } from "@sinclair/typebox/value";

/** Prefer the friendly macOS device label, with bounded local detection and a portable fallback. */
export async function resolveDefaultNodeName(): Promise<string> {
    if (process.platform === "darwin") {
        try {
            const { stdout } = await promisify(execFile)(
                "/usr/sbin/scutil",
                ["--get", "ComputerName"],
                {
                    timeout: 1_000,
                    maxBuffer: 4_096,
                },
            );
            const name = stdout.trim();
            if (Value.Check(nodeNameSchema, name)) return name;
        } catch {
            // Device-name discovery is optional and must not prevent daemon startup.
        }
    }
    const name = hostname();
    return Value.Check(nodeNameSchema, name) ? name : "Happy Agent";
}
