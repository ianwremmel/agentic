//! `dispatch` — CLI for the dispatch plugin.
//!
//! Today it exposes a single interaction command, `pr-status` (the §2.2 PR
//! Status Protocol producer), ported from the original bash script. The
//! command tree is structured to grow into the rest of §3.2 — daemon, prompt,
//! task, and the other interaction commands — without reshaping the entry point.

mod proc;
mod xml;

mod pr_status;

use clap::{Parser, Subcommand};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "dispatch",
    version,
    about = "Dispatch engineering work across pull requests and tickets.",
    propagate_version = true
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Emit PR state XML per §2.2 PR Status Protocol.
    PrStatus(pr_status::PrStatusArgs),
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let result = match cli.command {
        Command::PrStatus(args) => pr_status::run(args),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("dispatch: {e:#}");
            ExitCode::from(1)
        }
    }
}
