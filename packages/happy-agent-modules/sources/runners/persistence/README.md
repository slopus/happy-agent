# Runner snapshot persistence

One singleton row stores the public runner list and its UUIDv7 version: each configured runner's
name, connection status, and what the runner last reported about its machine. Machine
configuration stays authoritative for which runners exist and holds their tokens; tokens never
enter this table. Keeping the machine report across restarts is what places the home project and
bot folders on a runner before it has reconnected.
