import type { P2pTransportStatus } from "../protocol/P2pProtocol.js";
import type { P2pHttpRequest, P2pHttpResponse } from "./P2pHttp.js";
import type { P2pTunnelConnection, P2pTunnelRequestHead } from "./P2pTunnel.js";

export type P2pTransportKind = "direct" | "iroh" | "ssh";

export interface P2pTransport {
    readonly kind: P2pTransportKind;
    close(): Promise<void>;
    fetch?(peerId: string, request: P2pHttpRequest, signal: AbortSignal): Promise<P2pHttpResponse>;
    openTunnel?(
        peerId: string,
        request: P2pTunnelRequestHead,
        signal: AbortSignal,
    ): Promise<P2pTunnelConnection>;
    status(): P2pTransportStatus;
}
