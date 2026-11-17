import { execFileHidden } from "../../utils/hiddenChildProcess.js";
import { open, opendir, readdir, stat, statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { Context } from "@steve.kite/stdlib";
import type {
    SystemMonitorDisk,
    SystemMonitorGpu,
    SystemMonitorSnapshot,
} from "@slopus/happy-agent-client";
import {
    parseLinuxCpuTicks,
    parseLinuxDiskIo,
    parseLinuxMemory,
    parseLinuxMounts,
    parseLinuxProcess,
    parseLinuxGpu,
} from "./parseLinux.js";
import {
    parseMacDiskIo,
    parseMacDisks,
    parseMacGpus,
    parseMacMemory,
    parseMacProcesses,
} from "./parseMac.js";
import { parseWindowsDisks, parseWindowsGpus, parseWindowsProcesses } from "./parseWindows.js";
import { parseNvidia } from "./parseNvidia.js";
import { numberOrNull, type RawProcess } from "./parseProcess.js";

const runFile = promisify(execFileHidden);
const MAX_PROCESSES = 20000;
/** Even procfs/sysfs reads have a hard allocation bound. No command lines or environments are opened. */
export async function readBounded(path: string, maxBytes = 262144): Promise<string> {
    const handle = await open(path, "r");
    try {
        const buffer = Buffer.alloc(maxBytes + 1);
        let size = 0;
        while (size <= maxBytes) {
            const read = await handle.read(buffer, size, buffer.length - size, null);
            if (read.bytesRead === 0) return buffer.subarray(0, size).toString("utf8");
            size += read.bytesRead;
        }
        throw new Error("The host telemetry probe exceeded its output limit.");
    } finally {
        await handle.close();
    }
}
const maybeRead = async (path: string) => readBounded(path).catch(() => "");

/** Direct host probes owned by the sampler; never the agent's sandbox machine or a request. */
export class HostProbes {
    #clockTicks: Promise<number | null> | undefined;
    constructor(readonly ctx: Context) {}

    async command(file: string, args: string[]): Promise<string> {
        const result = await runFile(file, args, {
            encoding: "utf8",
            timeout: 1000,
            maxBuffer: 2 * 1024 ** 2,
            killSignal: "SIGKILL",
            env: { ...process.env, LC_ALL: "C", LANG: "C" },
            ...(this.ctx.lifetime === undefined ? {} : { signal: this.ctx.lifetime }),
        });
        return result.stdout;
    }
    async powershell(script: string): Promise<string> {
        return this.command("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$ErrorActionPreference = 'Stop'; ${script}`,
        ]);
    }
    async osName(): Promise<string> {
        if (process.platform === "linux")
            return (
                /^PRETTY_NAME=["']?(.+?)["']?$/m.exec(await readBounded("/etc/os-release"))?.[1] ??
                `Linux ${os.release()}`
            );
        if (process.platform === "darwin")
            return `macOS ${(await this.command("sw_vers", ["-productVersion"])).trim()}`;
        return `${os.type()} ${os.release()}`;
    }
    async memory(): Promise<SystemMonitorSnapshot["memory"] | null> {
        if (process.platform === "linux")
            return parseLinuxMemory(await readBounded("/proc/meminfo"));
        if (process.platform === "darwin") {
            const [vm, total, swap] = await Promise.all([
                this.command("vm_stat", []),
                this.command("sysctl", ["-n", "hw.memsize"]),
                this.command("sysctl", ["-n", "vm.swapusage"]),
            ]);
            return parseMacMemory(vm, numberOrNull(total.trim()) ?? os.totalmem(), swap);
        }
        const total = os.totalmem(),
            available = Math.min(total, os.freemem());
        return {
            totalBytes: total,
            availableBytes: available,
            usedBytes: total - available,
            cachedBytes: null,
            swapTotalBytes: null,
            swapUsedBytes: null,
        };
    }
    async disks(): Promise<SystemMonitorDisk[]> {
        if (process.platform === "darwin") return parseMacDisks(await this.command("df", ["-kP"]));
        if (process.platform === "win32")
            return parseWindowsDisks(
                await this.powershell(
                    "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -Property DeviceID,FileSystem,Size,FreeSpace | Select-Object DeviceID,FileSystem,Size,FreeSpace)",
                ),
            );
        if (process.platform !== "linux") return [];
        const mounts = parseLinuxMounts(
            await readBounded("/proc/self/mountinfo", 2 * 1024 ** 2),
        ).slice(0, 128);
        const result: SystemMonitorDisk[] = [];
        // Limit outstanding filesystem calls, including on machines with many volumes.
        for (let at = 0; at < mounts.length; at += 8) {
            const batch = await Promise.all(
                mounts.slice(at, at + 8).map(async (mount) => {
                    try {
                        if (!(await stat(mount.mountPoint)).isDirectory()) return null;
                        const fs = await statfs(mount.mountPoint);
                        return {
                            ...mount,
                            totalBytes: fs.blocks * fs.bsize,
                            usedBytes: Math.max(0, (fs.blocks - fs.bfree) * fs.bsize),
                            availableBytes: Math.max(0, fs.bavail * fs.bsize),
                        };
                    } catch {
                        return null;
                    }
                }),
            );
            for (const row of batch) if (row !== null) result.push(row);
        }
        return result;
    }
    async diskIo(): Promise<{ read: number; write: number } | null> {
        if (process.platform === "darwin")
            return parseMacDiskIo(
                await this.command("ioreg", ["-r", "-c", "IOBlockStorageDriver", "-l", "-w", "0"]),
            );
        if (process.platform !== "linux") return null;
        const devices = new Set(
            (await readdir("/sys/block")).filter((name) => !/^(?:loop|ram|zram|dm-|md)/.test(name)),
        );
        return parseLinuxDiskIo(await readBounded("/proc/diskstats"), devices);
    }
    async cpuTemperature(): Promise<number | null> {
        if (process.platform !== "linux") return null;
        for (const zone of (await readdir("/sys/class/thermal").catch(() => []))
            .filter((name) => /^thermal_zone\d+$/.test(name))
            .slice(0, 32)) {
            const root = `/sys/class/thermal/${zone}`;
            if (!/cpu|x86_pkg|soc_thermal/i.test(await maybeRead(`${root}/type`))) continue;
            const value = numberOrNull((await maybeRead(`${root}/temp`)).trim());
            if (value !== null) return value / 1000;
        }
        return null;
    }
    async gpus(): Promise<SystemMonitorGpu[]> {
        const nvidia = await this.command("nvidia-smi", [
            "--query-gpu=name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw",
            "--format=csv,noheader,nounits",
        ])
            .then(parseNvidia)
            .catch(() => []);
        if (process.platform === "darwin") {
            const apple = await this.command("ioreg", [
                "-r",
                "-c",
                "IOAccelerator",
                "-l",
                "-w",
                "0",
            ])
                .then((text) => parseMacGpus(text, os.cpus()[0]?.model ?? ""))
                .catch(() => []);
            return [...nvidia, ...apple];
        }
        if (process.platform === "win32")
            return nvidia.length > 0
                ? nvidia
                : parseWindowsGpus(
                      await this.powershell(
                          "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_VideoController -Property Name,AdapterCompatibility | Select-Object Name,AdapterCompatibility)",
                      ),
                  );
        if (process.platform !== "linux") return nvidia;
        const cards = (await readdir("/sys/class/drm").catch(() => []))
            .filter((name) => /^card\d+$/.test(name))
            .slice(0, 32);
        const others = await Promise.all(
            cards.map(async (card): Promise<SystemMonitorGpu | null> => {
                const root = `/sys/class/drm/${card}/device`;
                const vendorId = (await maybeRead(`${root}/vendor`)).trim();
                if (vendorId === "0x10de" && nvidia.length > 0) return null;
                const [usage, total, used, hwmon] = await Promise.all([
                    maybeRead(`${root}/gpu_busy_percent`),
                    maybeRead(`${root}/mem_info_vram_total`),
                    maybeRead(`${root}/mem_info_vram_used`),
                    readdir(`${root}/hwmon`).catch(() => []),
                ]);
                const temperature =
                    hwmon[0] === undefined
                        ? ""
                        : await maybeRead(`${root}/hwmon/${hwmon[0]}/temp1_input`);
                return parseLinuxGpu({ vendorId, busy: usage, total, used, temperature });
            }),
        );
        return [...nvidia, ...others.filter((gpu) => gpu !== null)];
    }
    /** CPU capacity is whole-machine procfs ticks on Linux, wall-clock milliseconds elsewhere. */
    async processes(): Promise<{
        items: RawProcess[];
        total: number;
        capacity: number | null;
    } | null> {
        if (process.platform === "darwin") {
            const items = parseMacProcesses(
                await this.command("ps", [
                    "-axo",
                    "pid=,ppid=,uid=,state=,rss=,time=,lstart=,comm=",
                ]),
            );
            return { items, total: items.length, capacity: null };
        }
        if (process.platform === "win32") {
            // Select at the CIM query boundary: command lines and environments are never fetched.
            const text = await this.powershell(
                "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,ThreadCount,KernelModeTime,UserModeTime,CreationDate | ForEach-Object { [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; Name=$_.Name; WorkingSetSize=$_.WorkingSetSize; ThreadCount=$_.ThreadCount; KernelModeTime=$_.KernelModeTime; UserModeTime=$_.UserModeTime; Started=$(if ($null -ne $_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {$null}) } })",
            );
            const items = parseWindowsProcesses(text);
            return items === null ? null : { items, total: items.length, capacity: null };
        }
        if (process.platform !== "linux") return null;
        const statText = await readBounded("/proc/stat");
        const boot = numberOrNull(/^btime (\d+)$/m.exec(statText)?.[1]);
        this.#clockTicks ??= this.command("getconf", ["CLK_TCK"])
            .then((v) => numberOrNull(v.trim()))
            .catch(() => null);
        const clockTicks = await this.#clockTicks;
        const pids: string[] = [];
        for await (const entry of await opendir("/proc")) {
            if (/^\d+$/.test(entry.name)) pids.push(entry.name);
            if (pids.length >= MAX_PROCESSES) break;
        }
        const items: RawProcess[] = [],
            deadline = performance.now() + 700;
        for (
            let at = 0;
            at < Math.min(pids.length, MAX_PROCESSES) &&
            performance.now() < deadline &&
            !this.ctx.lifetime?.aborted;
            at += 32
        ) {
            const batch = await Promise.all(
                pids.slice(at, at + 32).map(async (pid) => {
                    try {
                        const [statText, status] = await Promise.all([
                            readBounded(`/proc/${pid}/stat`, 16384),
                            readBounded(`/proc/${pid}/status`, 16384),
                        ]);
                        return parseLinuxProcess(
                            statText,
                            status,
                            clockTicks,
                            boot === null ? null : boot * 1000,
                        );
                    } catch {
                        return null;
                    } // Processes may exit or be unreadable between directory and file reads.
                }),
            );
            for (const row of batch) if (row !== null) items.push(row);
        }
        return { items, total: pids.length, capacity: parseLinuxCpuTicks(statText) };
    }
}
