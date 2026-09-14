# Service unit boundaries

These tests cover schemas, user-policy intersections, private control files, admission records,
and the Unix bridge handshake. The fake bridge is explicitly a transport unit fixture, not evidence
of namespace or resource isolation. Real service execution lives in `../live/serviceRuntime.live.test.ts`
and runs against the published supervisor with a disposable, explicitly delegated Linux cgroup.
