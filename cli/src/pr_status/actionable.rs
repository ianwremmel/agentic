//! Actionability classification — the Rust port of `has_terminal_signal`,
//! `classify_actionable`, and `parse_actionable` from the bash script.
//!
//! Full rules live in `plugins/dispatch/skills/deliver/reference.md`
//! → Actionability. The summary: an item is non-actionable iff its thread is
//! resolved, or its body is the calling agent's plan/engagement artifact, or it
//! is the calling agent's terminal-tagged reply.

use crate::xml;
use regex::Regex;
use std::sync::OnceLock;

/// Canonical terminal-signal regex, anchored to a single (already-isolated)
/// line. Mirrors `TERMINAL_RE`: canonical `done/declined/shipped`, the `✓`/`✅`
/// reaction-equivalents, and the legacy tokens — case-insensitive, optional
/// trailing period, surrounding whitespace tolerated.
fn terminal_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)^[[:space:]]*(✓|✅|done\.?|declined\.?|shipped\.?|acknowledged\.?|wontfix\.?|dismissed\.?|resolved\.?)[[:space:]]*$",
        )
        .expect("terminal regex is valid")
    })
}

/// Line-anchored agent plan/engagement sentinel.
fn agent_artifact_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?m)^<!-- agent-(plan|engagement):[^ ]+ -->$")
            .expect("artifact regex is valid")
    })
}

/// Returns true iff the body's last non-empty line is a canonical terminal
/// signal. Anchoring to the last non-empty line matches `reference.md`: inline
/// mentions of "done" in prose stay actionable.
pub fn has_terminal_signal(body: &str) -> bool {
    match body.lines().rev().find(|l| !l.trim().is_empty()) {
        Some(last) => terminal_re().is_match(last),
        None => false,
    }
}

/// The outcome of classifying one item.
pub struct Actionability {
    pub actionable: bool,
    /// Stable suppression token (`resolved`, `agent-artifact`,
    /// `agent-terminal-reply`); `None` when actionable.
    pub reason: Option<&'static str>,
}

impl Actionability {
    /// Render the ` reason="…"` attribute fragment (with the leading space),
    /// or an empty string when actionable / no reason — mirrors
    /// `parse_actionable`'s `$CA_REASON_ATTR`.
    pub fn reason_attr(&self) -> String {
        match (self.actionable, self.reason) {
            (false, Some(r)) => format!(" reason=\"{}\"", xml::attr(r)),
            _ => String::new(),
        }
    }

    pub fn actionable_str(&self) -> &'static str {
        if self.actionable {
            "true"
        } else {
            "false"
        }
    }
}

/// Holds the identities `classify_actionable` reads from the environment:
/// the gh-authenticated caller login (empty if `gh api user` failed) and the
/// configured `DISPATCH_AGENT_ID`.
pub struct Classifier {
    pub caller_login: Option<String>,
    pub agent_id: String,
}

impl Classifier {
    /// Classify an item given its newest body, that body's author login, and
    /// whether the enclosing thread is resolved.
    pub fn classify(&self, body: &str, author: &str, resolved: bool) -> Actionability {
        if resolved {
            return Actionability {
                actionable: false,
                reason: Some("resolved"),
            };
        }

        // Plan or engagement comment by the calling agent — an agent artifact,
        // not a reviewer item.
        if let Some(caller) = self.caller_login.as_deref() {
            if !caller.is_empty() && author == caller && agent_artifact_re().is_match(body) {
                return Actionability {
                    actionable: false,
                    reason: Some("agent-artifact"),
                };
            }
        }

        // Terminal-tagged reply by the calling agent.
        if has_terminal_signal(body) {
            match self.caller_login.as_deref() {
                Some(caller) if !caller.is_empty() => {
                    if author == caller && body.contains("<!-- agent-reply:") {
                        return Actionability {
                            actionable: false,
                            reason: Some("agent-terminal-reply"),
                        };
                    }
                }
                _ => {
                    // Degraded path: no caller identity; gate on the exact
                    // agent-id marker alone.
                    let marker = format!("<!-- agent-reply:{} -->", self.agent_id);
                    if body.contains(&marker) {
                        return Actionability {
                            actionable: false,
                            reason: Some("agent-terminal-reply"),
                        };
                    }
                }
            }
        }

        Actionability {
            actionable: true,
            reason: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classifier(caller: Option<&str>, agent: &str) -> Classifier {
        Classifier {
            caller_login: caller.map(|s| s.to_string()),
            agent_id: agent.to_string(),
        }
    }

    #[test]
    fn terminal_signal_on_last_nonempty_line() {
        assert!(has_terminal_signal("fixed it\n\nDone.\n"));
        assert!(has_terminal_signal("  ✅  "));
        assert!(has_terminal_signal("shipped"));
        // Inline mention is not a signal.
        assert!(!has_terminal_signal(
            "I think we are done here\nstill working"
        ));
        assert!(!has_terminal_signal(""));
        assert!(!has_terminal_signal("   \n  \n"));
    }

    #[test]
    fn resolved_thread_is_not_actionable() {
        let c = classifier(Some("alice"), "agent-1");
        let a = c.classify("anything", "bob", true);
        assert!(!a.actionable);
        assert_eq!(a.reason, Some("resolved"));
        assert_eq!(a.reason_attr(), r#" reason="resolved""#);
    }

    #[test]
    fn agent_artifact_requires_author_and_marker() {
        let c = classifier(Some("agent-bot"), "agent-1");
        let body = "<!-- agent-plan:agent-1 -->\nplan body";
        assert!(!c.classify(body, "agent-bot", false).actionable);
        // Same marker, different author → still actionable (human quoting it).
        assert!(c.classify(body, "human", false).actionable);
    }

    #[test]
    fn agent_terminal_reply_with_caller_identity() {
        let c = classifier(Some("agent-bot"), "agent-1");
        let body = "<!-- agent-reply:agent-1 -->\naddressed\nDone.";
        assert!(!c.classify(body, "agent-bot", false).actionable);
        // Terminal signal but wrong author → actionable.
        assert!(c.classify(body, "human", false).actionable);
    }

    #[test]
    fn degraded_path_gates_on_exact_marker() {
        let c = classifier(None, "agent-1");
        let body = "<!-- agent-reply:agent-1 -->\nDone.";
        assert!(!c.classify(body, "whoever", false).actionable);
        let other = "<!-- agent-reply:other-agent -->\nDone.";
        assert!(c.classify(other, "whoever", false).actionable);
    }

    #[test]
    fn plain_reviewer_comment_is_actionable() {
        let c = classifier(Some("agent-bot"), "agent-1");
        let a = c.classify("please fix this", "reviewer", false);
        assert!(a.actionable);
        assert_eq!(a.reason_attr(), "");
        assert_eq!(a.actionable_str(), "true");
    }
}
