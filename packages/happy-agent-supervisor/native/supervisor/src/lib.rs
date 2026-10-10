#[cfg(unix)]
mod cli;
#[cfg(unix)]
mod exec;
#[cfg(unix)]
mod hardening;
#[cfg(unix)]
mod platform;
#[cfg(unix)]
mod policy;
#[cfg(unix)]
mod proxy;
#[cfg(unix)]
mod service_policy;
#[cfg(windows)]
pub mod windows;

pub type SupervisorError = Box<dyn std::error::Error + Send + Sync>;
pub type SupervisorResult<T> = Result<T, SupervisorError>;

/// Build a supervisor invocation from inside the Happy Agent executable.
/// The caller adds its policy and workload arguments; no helper is located or extracted.
pub fn command() -> std::io::Result<std::process::Command> {
    let mut command = std::process::Command::new(std::env::current_exe()?);
    command.arg("supervisor");
    Ok(command)
}

#[cfg(unix)]
pub(crate) fn invalid_input(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into())
}

#[cfg(unix)]
pub fn run(arguments: impl IntoIterator<Item = std::ffi::OsString>) {
    let result = cli::Invocation::parse(arguments).and_then(|invocation| {
        invocation.policy.validate()?;
        platform::run(invocation.policy, invocation.command)
    });
    if let Err(error) = result {
        eprintln!("Happy Agent supervisor: {error}");
        std::process::exit(125);
    }
}
