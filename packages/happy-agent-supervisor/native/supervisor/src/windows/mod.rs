//! Windows process ownership shared by command sessions and the sandbox runner.
//!
//! The Job and ConPTY construction follow the native contract used by Happy's
//! pinned Codex Windows adapter. No subprocess invokes an additional executable
//! or runtime, and no running process is assigned to a Job after launch.
mod arguments;
mod attributes;
mod command;
mod handles;
mod job;
mod pipes;
mod process;
mod terminal;

pub use command::Command;
pub use job::Job;
pub use pipes::Stream;
pub use process::Child;
pub use terminal::{Control, create_terminal};

mod admission;
#[cfg(test)]
mod tests;
pub use admission::require_full_access;
