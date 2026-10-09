mod native_cli;

fn main() {
    let mut arguments = std::env::args_os();
    let _ = arguments.next();
    let command = arguments.next().unwrap_or_else(|| "--help".into());
    // The supervisor forks and installs OS policy before any async threads exist.
    if command == "supervisor" {
        #[cfg(unix)]
        {
            happy_agent_supervisor::run(arguments);
            return;
        }
        #[cfg(not(unix))]
        {
            eprintln!(
                "The Rust supervisor currently supports Linux and macOS. Windows sandbox helpers have not been migrated."
            );
            std::process::exit(125);
        }
    }
    if command == "--version" || command == "-V" {
        println!(
            "Happy Agent {}",
            option_env!("HAPPY_AGENT_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
        );
        return;
    }
    if command == "--help" || command == "-h" || command == "help" {
        println!(
            "Happy Agent — Rust provider and durable agent runtime\n\nUsage: happy-agent <command>\n\n  infer --config <file>                 Stream one provider request from stdin as JSON events\n  agent --config <file> --store <file>  Run a durable agent controlled by JSON lines\n  supervisor --policy-file <file> -- <command>  Execute a workload through the native Unix sandbox\n  --version                            Show the release version\n\nThe product daemon, desktop API, and terminal UI have not yet been migrated."
        );
        return;
    }
    let result = (|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        runtime.block_on(native_cli::run(command, arguments.collect()))
    })();
    if let Err(error) = result {
        eprintln!("Happy Agent: {error:#}");
        std::process::exit(1);
    }
}
