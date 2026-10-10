# Native scheduling learnings

Scheduled messages retain the original scheduling ID as their recipient message ID. Delivery
and outcome persistence remain separate short transactions, so replay rejoins the original Base
message while cancellation can race with a delivery already sent. The native owner registers
delivery in Durable Functions and commits that intent beside the original schedule row.

Wait records stay in the original module tables and hold no transaction while suspended. A
message or cancellation ends a live suspension; the result reports actual elapsed time. Durable
tool replay and reloadable graceful shutdown are separate Source contracts: timed waits are
durable and steerable, while only schedule listing is reloadable.

Startup reads the original pending schedule catalog in batches of 1,000, advancing by due time.
The shipped code skips remaining rows sharing the last batch's millisecond until the next start;
the native rewrite preserves that recovery boundary.
