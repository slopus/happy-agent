/**
 * How often each side of a runner connection pings the other.
 *
 * A runner reached through Tailcat can vanish without either side being told — a carrier that
 * stops, a machine that loses power — and only the missing pongs reveal it. Both the daemon and
 * the runner use these values, so each notices within the idle timeout plus one interval.
 */
export const RUNNER_PING_INTERVAL_MS = 5_000;

/**
 * How long a runner connection may stay silent before it is treated as gone.
 *
 * Every ping is answered, so a live connection is never silent for more than a round trip after
 * a ping. The timeout still allows a single large frame, such as a big file read, to cross a slow
 * relay: nothing else is received while it does.
 */
export const RUNNER_IDLE_TIMEOUT_MS = 20_000;

/**
 * How long a closing side waits for its last frames, including a goodbye, to leave before it
 * tears down the transport underneath.
 */
export const RUNNER_CLOSE_FLUSH_MS = 2_000;
