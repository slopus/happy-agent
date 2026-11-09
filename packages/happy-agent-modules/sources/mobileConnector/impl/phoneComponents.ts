import { phoneAppComponent, phonePairComponent } from "@slopus/happy-agent-client";

import type { ChatUiModule } from "../../chatUi/index.js";
import { MobileConnectorError } from "../MobileConnectorError.js";
import type { MobileConnectorModule } from "../MobileConnectorModule.js";

/**
 * Serve the phone components: the codes that download Happy's app, and this computer's pairing,
 * live. The pairing code is a one-time secret returned to the widget alone; the widget follows the
 * pairing through the mobile connector's own state and events.
 */
export function contributePhoneComponents(
    chatUi: ChatUiModule,
    mobileConnector: MobileConnectorModule,
): void {
    const refused = (error: unknown) => {
        if (!(error instanceof MobileConnectorError)) throw error;
        return { status: "rejected" as const, code: error.code, reason: error.message };
    };
    chatUi.contribute(phoneAppComponent, {
        prompt: "The codes that download Happy's phone app, to scan with the phone's camera.",
        fallback: () => "Get Happy on your phone from the App Store or Google Play.",
        actions: {},
    });
    chatUi.contribute(phonePairComponent, {
        prompt: "This computer's pairing code for Happy on the phone, live: the person scans it in the app and compares the emoji on both screens. A paired phone reaches you as a hidden note.",
        fallback: () => "Pair your phone in Happy on your computer.",
        actions: {
            start: async (ctx) => {
                let snapshot;
                try {
                    snapshot = await mobileConnector.startPairing(ctx);
                } catch (error: unknown) {
                    return refused(error);
                }
                const pairing = snapshot.pairing;
                if (pairing === null || pairing.qr === null) {
                    return {
                        status: "rejected",
                        code: "unavailable",
                        reason: pairing?.error ?? snapshot.error ?? "The pairing code isn't ready.",
                    };
                }
                return {
                    status: "accepted",
                    result: {
                        pairingId: pairing.id,
                        pairing: pairing.qr,
                        expiresAt: pairing.expiresAt,
                    },
                };
            },
            confirm: async (ctx, _offer, { pairingId }) => {
                try {
                    await mobileConnector.confirmPairing(ctx, pairingId);
                } catch (error: unknown) {
                    return refused(error);
                }
                return { status: "accepted" };
            },
            cancel: async (ctx, _offer, { pairingId }) => {
                try {
                    await mobileConnector.cancelPairing(ctx, pairingId);
                } catch (error: unknown) {
                    return refused(error);
                }
                return { status: "accepted" };
            },
        },
    });
}
