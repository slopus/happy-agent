import { spawnHidden } from "../../utils/hiddenChildProcess.js";
import type { Socket } from "node:net";
import { join } from "node:path";

import { readVhciPorts } from "./vhciPorts.js";

/** Why the kernel did not take a device. */
export class UsbAttachError extends Error {
    override readonly name = "UsbAttachError";

    constructor(
        readonly reason: "no_free_port" | "refused",
        message: string,
    ) {
        super(message);
    }
}

/** A device the kernel now drives, and the socket it reads the exporter's traffic from. */
export interface AttachedUsbDevice {
    readonly port: number;
    /** The daemon's end of the kernel's USB/IP connection. Closing it detaches the device. */
    readonly socket: Socket;
}

const USB_SPEED_SUPER = 5;
const ATTACH_TIMEOUT_MS = 10_000;

/**
 * Attaches one imported device to a free port of the virtual host controller.
 *
 * The kernel takes a USB/IP connection as a file descriptor written to its attach control, and
 * looks that descriptor up in the writing process. So a short helper is started with one end of a
 * socket pair as its descriptor 3 and writes `port 3 devid speed`; the kernel keeps its own
 * reference to that end, and the daemon keeps the other. Nothing else is shared with the helper.
 *
 * Another program may take a port between reading the status and writing the attachment, which
 * the kernel refuses. The status is read again after any refusal: a port that is no longer free
 * was taken, and the next one is tried; a port that is still free was refused for the device.
 */
export async function attachVhciDevice(
    controllerPath: string,
    device: { readonly devid: number; readonly speed: number },
): Promise<AttachedUsbDevice> {
    const hub = device.speed >= USB_SPEED_SUPER ? "ss" : "hs";
    // Older kernels know no faster speed than SuperSpeed, and a SuperSpeed Plus device works as one.
    const speed = Math.min(device.speed, USB_SPEED_SUPER);
    const tried = new Set<number>();
    for (;;) {
        const port = (await readVhciPorts(controllerPath)).find(
            (candidate) => candidate.hub === hub && candidate.free && !tried.has(candidate.port),
        );
        if (port === undefined) {
            throw new UsbAttachError(
                "no_free_port",
                "No USB port of the device's speed is free on the workspace's machine.",
            );
        }
        tried.add(port.port);
        const written = await writeAttachment(
            join(controllerPath, "attach"),
            `${String(port.port)} 3 ${String(device.devid)} ${String(speed)}`,
        );
        if ("socket" in written) return { port: port.port, socket: written.socket };
        const now = (await readVhciPorts(controllerPath)).find(
            (candidate) => candidate.port === port.port,
        );
        if (now?.free === true) throw new UsbAttachError("refused", written.error);
    }
}

async function writeAttachment(
    attachPath: string,
    line: string,
): Promise<{ readonly socket: Socket } | { readonly error: string }> {
    const child = spawnHidden(
        "/bin/sh",
        ["-c", 'printf "%s" "$1" > "$2"', "happy-agent-usb-attach", line, attachPath],
        {
            env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
            stdio: ["ignore", "ignore", "pipe", "pipe"],
        },
    );
    const socket = child.stdio[3] as Socket;
    socket.on("error", () => undefined);
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
        if (stderr.length < 2048) stderr += text;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), ATTACH_TIMEOUT_MS);
    timer.unref?.();
    const exitCode = await new Promise<number | null>((resolve) => {
        child.once("error", () => resolve(null));
        child.once("exit", (code) => resolve(code));
    });
    clearTimeout(timer);
    if (exitCode === 0) return { socket };
    socket.destroy();
    const detail = stderr.trim().split("\n").at(-1)?.trim();
    return {
        error:
            detail === undefined || detail === ""
                ? "The workspace's kernel refused the USB device."
                : `The workspace's kernel refused the USB device: ${detail.slice(0, 200)}`,
    };
}
