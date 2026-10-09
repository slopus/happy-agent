mod native_cli;
mod product;

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
    if command == "--version" || command == "-v" {
        println!(
            "Happy Agent {}",
            option_env!("HAPPY_AGENT_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
        );
        return;
    }
    if command == "--help" || command == "-h" {
        print!("{}", include_str!("product/usage.txt"));
        return;
    }
    let result = (|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let arguments: Vec<_> = arguments.collect();
        runtime.block_on(async move {
            if ["start", "run", "status", "drain", "stop", "kill", "reload"]
                .iter()
                .any(|name| command == *name)
            {
                anyhow::ensure!(
                    arguments.is_empty(),
                    "The {} command does not take arguments.\nRun happy-agent --help to see every command.", command.to_string_lossy()
                );
                if command == "run" {
                    product::run().await
                } else {
                    product::command(&command.to_string_lossy()).await
                }
            } else if command=="infer" || command=="agent" {
                native_cli::run(command, arguments).await
            } else if command=="runner" && arguments.first().is_some_and(|arg|arg=="--help" || arg=="-h") {
                print!("{}",include_str!("product/usage.txt"));
                Ok(())
            } else if command=="sandbox" {
                product::sandbox(arguments).await
            } else {
                anyhow::bail!("The Happy agent does not have a command called '{}'.\nRun happy-agent --help to see every command.",command.to_string_lossy());
            }
        })
    })();
    if let Err(error) = result {
        eprintln!("Happy Agent: {error:#}");
        std::process::exit(1);
    }
}
