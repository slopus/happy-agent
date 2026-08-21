import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { p2pStatusSchema } from "./P2pProtocol.js";

describe("P2P status protocol", () => {
    const namedStatus = {
        instanceId: "alocalinstance00000000001",
        name: "Studio Mac",
        publicKey: "A".repeat(43),
        transports: [
            {
                apiExposed: false,
                localAddress: "local-endpoint",
                peers: [
                    {
                        address: "remote-endpoint",
                        name: "Build server",
                        peerId: "aremoteinstance0000000001",
                        status: "connected",
                    },
                ],
                state: "ready",
                transport: "iroh",
            },
        ],
    };

    it("accepts display names for the local Happy Terminal and every identified peer", () => {
        expect(Value.Check(p2pStatusSchema, namedStatus)).toBe(true);
    });

    it("rejects a P2P status without the local Happy Terminal display name", () => {
        const { name: _name, ...statusWithoutName } = namedStatus;

        expect(Value.Check(p2pStatusSchema, statusWithoutName)).toBe(false);
    });

    it("rejects an identified peer without its display name", () => {
        const statusWithUnnamedPeer = {
            ...namedStatus,
            transports: [
                {
                    ...namedStatus.transports[0],
                    peers: [
                        {
                            address: "remote-endpoint",
                            peerId: "aremoteinstance0000000001",
                            status: "connected",
                        },
                    ],
                },
            ],
        };

        expect(Value.Check(p2pStatusSchema, statusWithUnnamedPeer)).toBe(false);
    });
});
