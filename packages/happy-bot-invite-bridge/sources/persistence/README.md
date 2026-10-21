# Private guest persistence

`GuestStore` owns one asynchronous SQLite connection and serializes its operations. Invitation
redemption and send deduplication use write transactions. A reply is inserted before the bridge
acknowledges the daemon, and a repeated bot/guest/sequence identity inserts nothing twice.

```text
invites (hashed link, capacity, bot, shared bridge guest) -> members (fixed seats, private sessions)
                         \-> shared messages (member attribution)
```

This database belongs only to the gateway. It never opens or modifies the daemon database.
Generation 3 uses `guests-v3.sqlite`; old preview invitations are not imported. A seat is claimed
conditionally in one write transaction. Nonce recovery happens before the capacity check;
revoked, blocked, and expired members never return their seats to the pool. History is scoped
to the invitation. Member revocation stops their access and pending sends while retaining their
names on earlier messages. Replies are routed by export bot and the invitation's shared guest.
