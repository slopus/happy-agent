//! Source's signal names remain stable; Windows has native Job termination.
pub(super) const SIGHUP: i32 = 1;
pub(super) const SIGINT: i32 = 2;
pub(super) const SIGQUIT: i32 = 3;
pub(super) const SIGKILL: i32 = 9;
pub(super) const SIGTERM: i32 = 15;
