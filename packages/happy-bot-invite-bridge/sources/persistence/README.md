# Private guest persistence

`GuestStore` owns one asynchronous SQLite connection and serializes its operations. Invitation
redemption and send deduplication use write transactions. A reply is inserted before the bridge
acknowledges the daemon, and a repeated bot/guest/sequence identity inserts nothing twice.

```text
invites (hashed credentials, bot, one guest, lifetime) -> messages (cursor, delivery)
```

This database belongs only to the gateway. It never opens or modifies the daemon database.
