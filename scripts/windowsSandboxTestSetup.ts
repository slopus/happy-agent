// Native test execution may use an already provisioned Happy sandbox, but it must
// never provision accounts/firewall rules or open UAC from an unattended suite.
if (process.platform === "win32") {
    process.env.HAPPY_WINDOWS_SANDBOX_NO_PROVISION = "1";
}
