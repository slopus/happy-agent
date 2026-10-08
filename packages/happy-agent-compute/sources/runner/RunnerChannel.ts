/** What a channel reports as it receives. */
export interface RunnerChannelReceiver {
    /** One complete frame, delivered in the order the other side sent it. */
    frame(frame: Uint8Array): void;
    /** The channel closed, for the human-readable reason given. Delivered once, after every frame. */
    close(reason: string): void;
}

/**
 * One ordered, message-framed connection between a daemon and a runner.
 *
 * The runner protocol does not care how bytes travel. A WebSocket carried over Tailcat, an SSH
 * channel, and an in-memory pair used by tests all look the same from here: whole frames in order,
 * and one close. Authentication belongs to whoever opened the channel; by the time a channel is
 * handed to the protocol, its other end has already proven who it is.
 */
export interface RunnerChannel {
    /** Deliver one frame to the other side. Sending on a closed channel is silently dropped. */
    send(frame: Uint8Array): void;
    /** Close both directions. Closing an already closed channel does nothing. */
    close(reason: string): void;
    /** Start receiving. A channel has exactly one receiver, installed once. */
    receive(receiver: RunnerChannelReceiver): void;
}
