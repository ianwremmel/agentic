//! Thin wrappers around external commands (`gh`, `git`, `claude`).
//!
//! The bash `pr-status` shells out to these tools; the Rust port keeps that
//! contract rather than re-implementing GitHub auth, GraphQL transport, or git
//! plumbing. Only the text-munging helpers (`jq`, `sha256sum`, `sed`, `tr`,
//! `grep`) are replaced with native Rust.

use anyhow::{anyhow, Context, Result};
use std::ffi::OsStr;
use std::process::{Command, Stdio};

/// Run a command and return its stdout as a `String`, with trailing newlines
/// stripped — matching shell `$(...)` command-substitution semantics. Returns
/// an error if the command fails to spawn or exits non-zero.
pub fn capture<I, S>(program: &str, args: I) -> Result<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = Command::new(program)
        .args(args)
        .stderr(Stdio::inherit())
        .output()
        .with_context(|| format!("failed to spawn `{program}`"))?;
    if !out.status.success() {
        return Err(anyhow!(
            "`{program}` exited with status {}",
            out.status.code().unwrap_or(-1)
        ));
    }
    Ok(strip_trailing_newlines(
        String::from_utf8_lossy(&out.stdout).as_ref(),
    ))
}

/// Like [`capture`], but on any failure (spawn error or non-zero exit) returns
/// `None` instead of an error — the Rust analogue of `… 2>/dev/null || echo …`
/// / `… || true` fallbacks in the script. stderr is suppressed.
pub fn capture_opt<I, S>(program: &str, args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let out = Command::new(program)
        .args(args)
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(strip_trailing_newlines(
        String::from_utf8_lossy(&out.stdout).as_ref(),
    ))
}

fn strip_trailing_newlines(s: &str) -> String {
    s.trim_end_matches(['\n', '\r']).to_string()
}
