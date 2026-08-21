# happy-worklets

The typed SDK available inside worklet processes. It connects to the private per-worklet Happy Agent
socket, registers TypeBox-defined tools, reports readiness and status, and receives tool calls.

Happy Agent ships the matching built SDK with its worklet runtime. Worklet source imports
`happy-worklets`; individual worklets do not vendor or install this package.
