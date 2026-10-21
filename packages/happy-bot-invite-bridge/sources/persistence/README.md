# Private guest persistence

`GuestStore` owns one asynchronous SQLite connection and serializes its operations. Invitation
redemption and send deduplication use write transactions. A reply is inserted before the bridge
acknowledges the daemon, and a repeated bot/guest/sequence identity inserts nothing twice.

```text
invites (hashed link, capacity, bot) -> members (fixed guest pool, private session) -> messages
```

This database belongs only to the gateway. It never opens or modifies the daemon database.
Generation 2 uses `guests-v2.sqlite`; old preview invitations are not imported. A seat is claimed
conditionally in one write transaction. Nonce recovery happens before the capacity check;
revoked, blocked, and expired members never return their guest IDs to the pool.
