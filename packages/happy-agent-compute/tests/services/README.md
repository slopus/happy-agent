# Service unit boundaries

These tests cover schemas, user-policy intersections, private control files, admission records,
and the Unix bridge handshake. The fake bridge is explicitly a transport unit fixture, not evidence
of namespace or resource isolation. Real service execution lives in `../live/serviceRuntime.live.test.ts`
and runs against the published supervisor with a disposable, explicitly delegated Linux cgroup.

`serviceReconciliation` scripts both process execution and native proof. It verifies that failed
completion retains capacity, and only successful reconciliation releases that capacity and permits
a previously failed disposal to finish. It makes no claim to exercise the kernel sandbox.
