# Invitation gateway source

`main.ts` owns the local CLI, private export registry, and process lifetime. `GuestServer.ts`
owns the scoped guest HTTP contract and long polling. `ExportedBotBridge.ts` owns the existing
exported-bot WebSocket and reconnects. `contracts.ts` validates external values with TypeBox.
`formatGroupMessage.ts` quotes untrusted body text with immutable server-assigned member
attribution, while the bridge's conversation identity and label belong to the invitation.

```text
main -> GuestServer -> ExportedBotBridge
                 \-> persistence/GuestStore
```

The bridge stores neither owner authentication nor owner conversations. See the package README
for the owner setup sequence, public deployment boundary, and native contract.
