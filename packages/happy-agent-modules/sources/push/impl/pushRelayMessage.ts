import type { PushNotification } from "../PushNotification.js";
import type { PushOwner } from "../PushRegistration.js";
import type { PushToken } from "../PushToken.js";

/** Which installation and person a notification is for, as the phone matches them. */
export interface PushRelayAddress {
    readonly instanceId: string;
    readonly userId: PushOwner;
}

/**
 * The relay request for one notification to one phone. `data` carries exactly these five strings:
 * the Android app refuses a payload with any other set of keys. The relay's schema is closed too,
 * so `collapseId` is sent only when the notification has one.
 */
export function pushRelayMessage(
    token: PushToken,
    address: PushRelayAddress,
    notification: PushNotification,
): Record<string, unknown> {
    return {
        to: token.expose(),
        title: notification.title,
        body: notification.body,
        data: {
            kind: "happy.cloud.push.v1",
            instanceId: address.instanceId,
            userId: address.userId,
            agentId: notification.agentId,
            notificationId: notification.notificationId,
        },
        ...(notification.collapseId === undefined ? {} : { collapseId: notification.collapseId }),
        sound: "default",
        channelId: "messages",
        ttl: 300,
    };
}
