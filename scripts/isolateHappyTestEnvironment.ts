// A test must never sign in to the developer's Happy account. A shell (or a Happy Agent daemon)
// that exports these would point every test runtime at the real Happy CLI login and server, so
// they are removed before any test runs; a test that needs them passes its own values to the
// runtime it starts. Without them, a runtime reads the Happy login only from its own root.
for (const name of ["HAPPY_HOME_DIR", "HAPPY_SERVER_URL", "HAPPY_AGENT_HAPPY_SERVER_URL"]) {
    delete process.env[name];
}
