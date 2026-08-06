export interface DirectAddress {
    host: string;
    port: number;
}

export function parseDirectAddress(value: string, allowZeroPort = false): DirectAddress {
    const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/u.exec(value);
    const plain = /^([^:[\]\s]+):(\d{1,5})$/u.exec(value);
    const match = bracketed ?? plain;
    if (match === null) {
        throw new Error(
            "A direct P2P address must be a hostname and port, such as host.example:7443 or [::1]:7443.",
        );
    }
    const host = match[1]!;
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port > 65_535 || (allowZeroPort ? port < 0 : port < 1)) {
        throw new Error("A direct P2P address must use a port from 1 to 65535.");
    }
    return { host, port };
}

export function formatDirectAddress(address: DirectAddress): string {
    return `${address.host.includes(":") ? `[${address.host}]` : address.host}:${String(address.port)}`;
}
