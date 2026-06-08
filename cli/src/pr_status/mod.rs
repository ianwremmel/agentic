//! `dispatch pr-status` — emit PR state XML per §2.2 PR Status Protocol.
//!
//! A faithful port of `plugins/dispatch/skills/deliver/scripts/pr-status`. It
//! shells out to `gh`, `git`, and `claude` exactly as the bash did (so GitHub
//! auth, GraphQL transport, and git plumbing are unchanged); the text munging
//! that bash delegated to `jq`/`sha256sum`/`sed`/`tr`/`grep` is native Rust.

mod actionable;
mod sections;

use anyhow::{bail, Context, Result};
use regex::Regex;
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::proc;
use crate::xml;
use actionable::Classifier;

#[derive(clap::Args, Debug)]
pub struct PrStatusArgs {
    /// PR number, URL, or branch — passed through to `gh pr view`.
    pub pr: String,
}

const THREADS_QUERY: &str = r#"
    query($owner:String!, $repo:String!, $pr:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          reviewThreads(first:100) {
            nodes {
              id
              isResolved
              isOutdated
              path
              comments(last:50) {
                nodes { id databaseId body author { login } createdAt }
              }
            }
          }
        }
      }
    }"#;

const COMMENTS_QUERY: &str = r#"
    query($owner:String!, $repo:String!, $pr:Int!, $endCursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          comments(first:100, after:$endCursor) {
            nodes {
              id
              databaseId
              body
              author { login }
              reactions(first:100) {
                nodes { content user { login } }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }"#;

const REVIEWS_QUERY: &str = r#"
    query($owner:String!, $repo:String!, $pr:Int!, $endCursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          reviews(first:100, after:$endCursor) {
            nodes { author { login __typename } state }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }"#;

const REVIEW_REQUESTS_QUERY: &str = r#"
    query($owner:String!, $repo:String!, $pr:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          reviewRequests(first:100) {
            nodes {
              requestedReviewer {
                __typename
                ... on User { login }
                ... on Bot { login }
                ... on Mannequin { login }
                ... on Team { name slug }
              }
            }
          }
        }
      }
    }"#;

/// Per-invocation context shared by the section emitters.
struct Ctx {
    pr_arg: String,
    repo: String,
    owner: String,
    repo_name: String,
    pr_number: String,
    head: String,
    dir: PathBuf,
    operator_lc: String,
    classifier: Classifier,
    info_re: Option<Regex>,
    stuck_after: i64,
    now: i64,
    pr_json: Value,
}

pub fn run(args: PrStatusArgs) -> Result<()> {
    let pr = args.pr;
    if pr.is_empty() {
        bail!("usage: pr-status <pr>");
    }

    let agent_id = require_env("DISPATCH_AGENT_ID")?;
    let skill = require_env("DISPATCH_SKILL")?;
    let operator_login = require_env("DISPATCH_OPERATOR_LOGIN").context(
        "DISPATCH_OPERATOR_LOGIN required (operator GitHub login; see §2.2.2 Operator identity)",
    )?;
    let operator_lc = operator_login.to_lowercase();

    let repo = proc::capture(
        "gh",
        [
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "-q",
            ".nameWithOwner",
        ],
    )
    .context("gh repo view failed")?;
    let (owner, repo_name) = repo
        .split_once('/')
        .map(|(o, r)| (o.to_string(), r.to_string()))
        .unwrap_or_else(|| (repo.clone(), String::new()));
    let slug = repo.replace('/', "__");

    let info_re = match env::var("DISPATCH_INFORMATIONAL_CHECKS") {
        Ok(s) if !s.is_empty() => {
            Some(Regex::new(&format!("(?i){s}")).context("invalid DISPATCH_INFORMATIONAL_CHECKS")?)
        }
        _ => None,
    };
    let stuck_after: i64 = env::var("DISPATCH_STUCK_AFTER_SEC")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3600);

    let caller_login =
        proc::capture_opt("gh", ["api", "user", "--jq", ".login"]).filter(|s| !s.is_empty());
    if caller_login.is_none() {
        eprintln!(
            "pr-status: warning: gh api user failed; author-identity actionability fallback disabled"
        );
    }

    // --- fetch PR_JSON --------------------------------------------------------
    let pr_json_str = proc::capture(
        "gh",
        [
            "pr",
            "view",
            &pr,
            "--json",
            "number,headRefName,headRefOid,baseRefName,state,mergedAt,mergeable,reviewDecision,isDraft,statusCheckRollup",
        ],
    )
    .context("gh pr view failed")?;
    let pr_json: Value = serde_json::from_str(&pr_json_str).context("parsing gh pr view JSON")?;

    let head = pr_json
        .get("headRefName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let pr_number = pr_json
        .get("number")
        .and_then(Value::as_i64)
        .map(|n| n.to_string())
        .unwrap_or_default();

    // The cache layout keys on the skill name verbatim (matching the bash
    // `$DISPATCH_SKILL/$SLUG/$PR` path).
    let dir = cache_base().join(&skill).join(&slug).join(&pr);
    for sub in ["comments", "threads", "annotations"] {
        fs::create_dir_all(dir.join(sub))
            .with_context(|| format!("creating cache dir {}", dir.join(sub).display()))?;
    }

    // --- fetch threads / comments / reviews via GraphQL -----------------------
    let f_owner = format!("owner={owner}");
    let f_repo = format!("repo={repo_name}");
    let f_pr = format!("pr={pr_number}");

    let threads_json = parse_array(&gh_graphql(
        &[&f_owner, &f_repo, &f_pr],
        false,
        THREADS_QUERY,
        ".data.repository.pullRequest.reviewThreads.nodes // []",
    )?);

    let comments_json = lines_to_array(&gh_graphql(
        &[&f_owner, &f_repo, &f_pr],
        true,
        COMMENTS_QUERY,
        ".data.repository.pullRequest.comments.nodes[]",
    )?)?;

    let review_nodes = lines_to_array(&gh_graphql(
        &[&f_owner, &f_repo, &f_pr],
        true,
        REVIEWS_QUERY,
        ".data.repository.pullRequest.reviews.nodes[]",
    )?)?;

    let review_request_nodes = parse_array(&gh_graphql(
        &[&f_owner, &f_repo, &f_pr],
        false,
        REVIEW_REQUESTS_QUERY,
        ".data.repository.pullRequest.reviewRequests.nodes // []",
    )?);

    let reviews_json = serde_json::json!({
        "reviews": { "nodes": review_nodes },
        "reviewRequests": { "nodes": review_request_nodes },
    });

    let ctx = Ctx {
        pr_arg: pr,
        repo,
        owner,
        repo_name,
        pr_number,
        head,
        dir,
        operator_lc,
        classifier: Classifier {
            caller_login,
            agent_id,
        },
        info_re,
        stuck_after,
        now: chrono::Utc::now().timestamp(),
        pr_json,
    };

    // --- emit -----------------------------------------------------------------
    let mut out = String::new();
    out.push_str(&format!(
        "<pr-status repo=\"{}\" pr=\"{}\" head=\"{}\">\n",
        xml::attr(&ctx.repo),
        xml::attr(&ctx.pr_arg),
        xml::attr(&ctx.head)
    ));
    out.push_str(&terminal_xml(&ctx));
    out.push('\n');
    out.push_str(&sections::checks_xml(
        &ctx.pr_json,
        ctx.info_re.as_ref(),
        ctx.stuck_after,
        ctx.now,
    ));
    out.push('\n');
    out.push_str(&sections::conflicts_xml(&ctx.pr_json));
    out.push('\n');
    out.push_str(&sections::reviews_xml(&reviews_json, &ctx.operator_lc));
    out.push('\n');
    out.push_str(&comments_xml(&ctx, &comments_json));
    out.push('\n');
    out.push_str(&threads_xml(&ctx, &threads_json));
    out.push('\n');
    out.push_str(&annotations_xml(&ctx));
    out.push('\n');
    out.push_str("</pr-status>\n");

    print!("{out}");
    Ok(())
}

// --- env / paths -------------------------------------------------------------

fn require_env(name: &str) -> Result<String> {
    match env::var(name) {
        Ok(v) if !v.is_empty() => Ok(v),
        _ => bail!("{name} required"),
    }
}

/// `${DISPATCH_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/dispatch}`.
fn cache_base() -> PathBuf {
    if let Ok(d) = env::var("DISPATCH_CACHE_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let parent = match env::var("XDG_CACHE_HOME") {
        Ok(x) if !x.is_empty() => PathBuf::from(x),
        _ => PathBuf::from(env::var("HOME").unwrap_or_default()).join(".cache"),
    };
    parent.join("dispatch")
}

// --- gh / json helpers -------------------------------------------------------

/// Run `gh api graphql` with the shared `-F` field args, the query, and a
/// `--jq` filter; return stdout. `paginate` adds `--paginate`.
fn gh_graphql(fields: &[&str], paginate: bool, query: &str, jq: &str) -> Result<String> {
    let q = format!("query={query}");
    let mut args: Vec<String> = vec!["api".into(), "graphql".into()];
    if paginate {
        args.push("--paginate".into());
    }
    for f in fields {
        args.push("-F".into());
        args.push((*f).to_string());
    }
    args.push("-f".into());
    args.push(q);
    args.push("--jq".into());
    args.push(jq.to_string());
    proc::capture("gh", &args).context("gh api graphql failed")
}

/// Parse a `--jq '… // []'` result into an array `Value` (empty array on any
/// parse failure, matching the bash fallbacks).
fn parse_array(s: &str) -> Value {
    match serde_json::from_str::<Value>(s) {
        Ok(v @ Value::Array(_)) => v,
        _ => Value::Array(Vec::new()),
    }
}

/// Collect newline-delimited JSON objects (from `gh --paginate … --jq 'nodes[]'`)
/// into a single array `Value` — the Rust analogue of `… | jq -s '.'`.
fn lines_to_array(s: &str) -> Result<Value> {
    let mut v = Vec::new();
    for line in s.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        v.push(serde_json::from_str(t).context("parsing paginated GraphQL node")?);
    }
    Ok(Value::Array(v))
}

fn sha256_hex(body: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    let digest = h.finalize();
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// `[^A-Za-z0-9_=-] -> _` — the bash id sanitizer.
fn sanitize_id(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '=' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

// --- cache + summaries -------------------------------------------------------

/// Write `<id>.md` (and its `.hash`) under `<dir>/<sub>` when the body changes.
fn cache_item(dir: &Path, sub: &str, id: &str, body: &str) -> Result<()> {
    let md = dir.join(sub).join(format!("{id}.md"));
    let hash_file = dir.join(sub).join(format!("{id}.hash"));
    let new_hash = sha256_hex(body);
    let old_hash = fs::read_to_string(&hash_file).unwrap_or_default();
    if !md.exists() || new_hash != old_hash {
        fs::write(&md, body).with_context(|| format!("writing cache {}", md.display()))?;
        fs::write(&hash_file, &new_hash)?;
    }
    Ok(())
}

/// Generate a 1–3 sentence recap of `body_path` into `out_path` via `claude -p`.
/// On any failure writes `(summary unavailable)`, matching the bash fallback.
fn summarize(body_path: &Path, out_path: &Path) {
    let body = fs::read_to_string(body_path).unwrap_or_default();
    let prompt = format!(
        "Summarize the following PR item in 1-3 sentences describing its outcome. Plain prose only.\n\n{body}"
    );
    let result = Command::new("claude")
        .args(["-p", "--max-turns", "1", &prompt])
        .stderr(Stdio::null())
        .output();
    let written = match result {
        Ok(o) if o.status.success() => fs::write(out_path, &o.stdout).is_ok(),
        _ => false,
    };
    if !written {
        let _ = fs::write(out_path, "(summary unavailable)\n");
    }
}

/// Read a summary file and strip trailing whitespace/newlines (the `$(cat …)`
/// semantics at the emit site).
fn read_summary(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_default()
        .trim_end()
        .to_string()
}

// --- comments ----------------------------------------------------------------

fn comments_xml(ctx: &Ctx, comments_json: &Value) -> String {
    let mut out = String::from("  <comments>\n");
    let empty = Vec::new();
    for c in comments_json.as_array().unwrap_or(&empty) {
        let raw_id = c
            .get("id")
            .and_then(Value::as_str)
            .map(|s| s.to_string())
            .or_else(|| {
                c.get("databaseId")
                    .and_then(Value::as_i64)
                    .map(|n| n.to_string())
            })
            .unwrap_or_default();
        if raw_id.is_empty() {
            continue;
        }
        let author = c
            .pointer("/author/login")
            .and_then(Value::as_str)
            .unwrap_or("");
        let body = c.get("body").and_then(Value::as_str).unwrap_or("");
        let reactions = c
            .pointer("/reactions/nodes")
            .cloned()
            .unwrap_or(Value::Array(Vec::new()));

        let id = sanitize_id(&raw_id);
        let _ = cache_item(&ctx.dir, "comments", &id, body);
        let act = ctx.classifier.classify(body, author, false);

        let cache_path = ctx.dir.join("comments").join(format!("{id}.md"));
        let sum_path = ctx.dir.join("comments").join(format!("{id}.summary.md"));
        if !act.actionable && !sum_path.exists() {
            summarize(&cache_path, &sum_path);
        }

        let mut inner = String::new();
        if sum_path.exists() {
            inner.push_str(&format!(
                "<summary>{}</summary>",
                xml::text(&read_summary(&sum_path))
            ));
        }
        inner.push_str(&sections::reactions_xml_for(&reactions));

        let cache_attr = xml::attr(&cache_path.to_string_lossy());
        if inner.is_empty() {
            out.push_str(&format!(
                "    <comment id=\"{}\" actionable=\"{}\"{} cache=\"{}\"/>\n",
                xml::attr(&id),
                act.actionable_str(),
                act.reason_attr(),
                cache_attr
            ));
        } else {
            out.push_str(&format!(
                "    <comment id=\"{}\" actionable=\"{}\"{} cache=\"{}\">{}</comment>\n",
                xml::attr(&id),
                act.actionable_str(),
                act.reason_attr(),
                cache_attr,
                inner
            ));
        }
    }
    out.push_str("  </comments>");
    out
}

// --- review threads ----------------------------------------------------------

fn threads_xml(ctx: &Ctx, threads_json: &Value) -> String {
    let mut out = String::from("  <threads>\n");
    let empty = Vec::new();
    for t in threads_json.as_array().unwrap_or(&empty) {
        let id = t.get("id").and_then(Value::as_str).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let resolved = t
            .get("isResolved")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let nodes_empty = Vec::new();
        let nodes = t
            .pointer("/comments/nodes")
            .and_then(Value::as_array)
            .unwrap_or(&nodes_empty);
        let body = nodes
            .iter()
            .map(|n| {
                let a = n
                    .pointer("/author/login")
                    .and_then(Value::as_str)
                    .unwrap_or("?");
                let b = n.get("body").and_then(Value::as_str).unwrap_or("");
                format!("[{a}] {b}")
            })
            .collect::<Vec<_>>()
            .join("\n\n---\n\n");
        let newest_body = nodes
            .last()
            .and_then(|n| n.get("body").and_then(Value::as_str))
            .unwrap_or("");
        let newest_author = nodes
            .last()
            .and_then(|n| n.pointer("/author/login").and_then(Value::as_str))
            .unwrap_or("");

        let id = sanitize_id(id);
        let _ = cache_item(&ctx.dir, "threads", &id, &body);
        let act = ctx
            .classifier
            .classify(newest_body, newest_author, resolved);

        let cache_path = ctx.dir.join("threads").join(format!("{id}.md"));
        let sum_path = ctx.dir.join("threads").join(format!("{id}.summary.md"));
        if !act.actionable && !sum_path.exists() {
            summarize(&cache_path, &sum_path);
        }

        let cache_attr = xml::attr(&cache_path.to_string_lossy());
        if sum_path.exists() {
            out.push_str(&format!(
                "    <thread id=\"{}\" actionable=\"{}\"{} cache=\"{}\"><summary>{}</summary></thread>\n",
                xml::attr(&id),
                act.actionable_str(),
                act.reason_attr(),
                cache_attr,
                xml::text(&read_summary(&sum_path))
            ));
        } else {
            out.push_str(&format!(
                "    <thread id=\"{}\" actionable=\"{}\"{} cache=\"{}\"/>\n",
                xml::attr(&id),
                act.actionable_str(),
                act.reason_attr(),
                cache_attr
            ));
        }
    }
    out.push_str("  </threads>");
    out
}

// --- annotations -------------------------------------------------------------

fn annotations_xml(ctx: &Ctx) -> String {
    let mut out = String::from("  <annotations>\n");
    let sha = ctx
        .pr_json
        .get("headRefOid")
        .and_then(Value::as_str)
        .unwrap_or("");

    let runs_str = proc::capture_opt(
        "gh",
        [
            "api",
            &format!(
                "repos/{}/{}/commits/{}/check-runs",
                ctx.owner, ctx.repo_name, sha
            ),
            "--jq",
            ".check_runs // []",
        ],
    )
    .unwrap_or_else(|| "[]".to_string());
    let runs = parse_array(&runs_str);

    let empty = Vec::new();
    for run in runs.as_array().unwrap_or(&empty) {
        let run_id = match run.get("id").and_then(Value::as_i64) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let anns_str = proc::capture_opt(
            "gh",
            [
                "api",
                &format!(
                    "repos/{}/{}/check-runs/{}/annotations",
                    ctx.owner, ctx.repo_name, run_id
                ),
            ],
        )
        .unwrap_or_else(|| "[]".to_string());
        let anns = parse_array(&anns_str);

        for a in anns.as_array().unwrap_or(&empty) {
            let path = a.get("path").and_then(Value::as_str).unwrap_or("");
            let line = a.get("start_line").and_then(Value::as_i64).unwrap_or(0);
            let msg = a.get("message").and_then(Value::as_str).unwrap_or("");
            let body = format!("[{path}:{line}] {msg}");
            let id: String = sha256_hex(&body).chars().take(16).collect();

            let _ = cache_item(&ctx.dir, "annotations", &id, &body);
            let ack = ctx.dir.join("annotations").join(format!("{id}.ack"));
            let cache_path = ctx.dir.join("annotations").join(format!("{id}.md"));
            let sum_path = ctx.dir.join("annotations").join(format!("{id}.summary.md"));
            let cache_attr = xml::attr(&cache_path.to_string_lossy());

            if ack.exists() {
                if !sum_path.exists() {
                    summarize(&cache_path, &sum_path);
                }
                out.push_str(&format!(
                    "    <annotation id=\"{}\" actionable=\"false\" reason=\"acked\" cache=\"{}\"><summary>{}</summary></annotation>\n",
                    xml::attr(&id),
                    cache_attr,
                    xml::text(&read_summary(&sum_path))
                ));
            } else {
                out.push_str(&format!(
                    "    <annotation id=\"{}\" actionable=\"true\" cache=\"{}\"/>\n",
                    xml::attr(&id),
                    cache_attr
                ));
            }
        }
    }
    out.push_str("  </annotations>");
    out
}

// --- terminal resolution -----------------------------------------------------

/// Result of the content-presence check: did the PR's net change land in base?
#[derive(Debug, PartialEq, Eq)]
enum Presence {
    Shipped,
    Abandoned,
    Unavailable,
}

fn terminal_xml(ctx: &Ctx) -> String {
    let pr = &ctx.pr_json;
    let state = pr.get("state").and_then(Value::as_str).unwrap_or("");
    let merged_at = pr.get("mergedAt").and_then(Value::as_str).unwrap_or("");
    let base_ref = pr.get("baseRefName").and_then(Value::as_str).unwrap_or("");
    let head_oid = pr.get("headRefOid").and_then(Value::as_str).unwrap_or("");
    let is_draft = pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false);

    let gh_merged = state == "MERGED" || !merged_at.is_empty();

    if state == "OPEN" {
        let s = if is_draft { "draft" } else { "open" };
        return format!("  <terminal state=\"{s}\" gh-merged=\"{gh_merged}\" ahead-by=\"-\"/>");
    }

    if gh_merged {
        return r#"  <terminal state="shipped" gh-merged="true" ahead-by="-"/>"#.to_string();
    }

    // CLOSED without `merged`: one three-dot compare, read ahead_by.
    let ahead_by = proc::capture_opt(
        "gh",
        [
            "api",
            &format!(
                "repos/{}/{}/compare/{}...{}",
                ctx.owner, ctx.repo_name, base_ref, head_oid
            ),
            "--jq",
            ".ahead_by",
        ],
    );

    if ahead_by.as_deref() == Some("0") {
        return r#"  <terminal state="shipped" gh-merged="false" ahead-by="0"/>"#.to_string();
    }

    let ab_attr = match ahead_by.as_deref() {
        Some(s) if !s.is_empty() => s,
        _ => "-",
    };

    match content_present(&ctx.pr_number, base_ref) {
        Presence::Shipped => format!(
            "  <terminal state=\"shipped\" gh-merged=\"false\" ahead-by=\"{ab_attr}\"/>"
        ),
        Presence::Abandoned => format!(
            "  <terminal state=\"abandoned\" gh-merged=\"false\" ahead-by=\"{ab_attr}\"/>"
        ),
        Presence::Unavailable => format!(
            "  <terminal state=\"abandoned\" gh-merged=\"false\" ahead-by=\"{ab_attr}\" error=\"content-check-unavailable\"/>"
        ),
    }
}

/// Squash/rebase-safe content check (see the bash `content_present`). Side
/// effect free: never touches the caller's worktree, index, or HEAD.
fn content_present(pr_number: &str, base_ref: &str) -> Presence {
    let git_ok = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    };
    let git_capture = |args: &[&str]| -> Option<String> {
        let out = Command::new("git")
            .args(args)
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    };

    if !git_ok(&["rev-parse", "--git-dir"]) {
        return Presence::Unavailable;
    }
    let head_ref = format!("refs/pull/{pr_number}/head");
    if !git_ok(&["fetch", "--quiet", "origin", &head_ref]) {
        return Presence::Unavailable;
    }
    let head_sha = match git_capture(&["rev-parse", "--verify", "--quiet", "FETCH_HEAD"]) {
        Some(s) => s,
        None => return Presence::Unavailable,
    };
    if !git_ok(&["fetch", "--quiet", "origin", base_ref]) {
        return Presence::Unavailable;
    }
    let base_sha = match git_capture(&["rev-parse", "--verify", "--quiet", "FETCH_HEAD"]) {
        Some(s) => s,
        None => return Presence::Unavailable,
    };
    let mb = match git_capture(&["merge-base", &base_sha, &head_sha]) {
        Some(s) => s,
        None => return Presence::Unavailable,
    };

    // No-op PR: empty net patch is trivially present → shipped.
    if git_ok(&["diff", "--quiet", &mb, &head_sha]) {
        return Presence::Shipped;
    }

    // Temp index seeded from the base tip; free the path first.
    let tmp_index = match proc::capture_opt("mktemp", Vec::<&str>::new()) {
        Some(p) if !p.is_empty() => p,
        _ => return Presence::Unavailable,
    };
    let _ = fs::remove_file(&tmp_index);

    let read_tree = Command::new("git")
        .args(["read-tree", &base_sha])
        .env("GIT_INDEX_FILE", &tmp_index)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !read_tree {
        let _ = fs::remove_file(&tmp_index);
        return Presence::Unavailable;
    }

    // diff --binary mb head | git apply --reverse --cached --check -
    let diff = Command::new("git")
        .args(["diff", "--binary", &mb, &head_sha])
        .stderr(Stdio::null())
        .output();
    let result = match diff {
        Ok(d) if d.status.success() => apply_reverse_check(&tmp_index, &d.stdout),
        _ => false,
    };
    let _ = fs::remove_file(&tmp_index);

    if result {
        Presence::Shipped
    } else {
        Presence::Abandoned
    }
}

/// Pipe a patch into `git apply --reverse --cached --check -` against the given
/// temp index; return true iff it applies cleanly.
fn apply_reverse_check(index_path: &str, patch: &[u8]) -> bool {
    use std::io::Write;
    let mut child = match Command::new("git")
        .args(["apply", "--reverse", "--cached", "--check", "-"])
        .env("GIT_INDEX_FILE", index_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    if let Some(mut stdin) = child.stdin.take() {
        if stdin.write_all(patch).is_err() {
            return false;
        }
    }
    child.wait().map(|s| s.success()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_known_vector() {
        assert_eq!(
            sha256_hex(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sanitize_id_replaces_unsafe() {
        assert_eq!(sanitize_id("PRRT_kwDO=ab-12/3:x"), "PRRT_kwDO=ab-12_3_x");
    }

    #[test]
    fn parse_array_falls_back_to_empty() {
        assert_eq!(parse_array("not json"), Value::Array(vec![]));
        assert_eq!(parse_array("{}"), Value::Array(vec![]));
        assert_eq!(parse_array("[1,2]"), serde_json::json!([1, 2]));
    }

    #[test]
    fn lines_to_array_collects_objects() {
        let v = lines_to_array("{\"a\":1}\n\n{\"b\":2}\n").unwrap();
        assert_eq!(v, serde_json::json!([{"a":1},{"b":2}]));
    }
}
