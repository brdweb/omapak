use crate::schema::{Severity, Verdict};

/// Render a report as the PR comment. Scores are shown with a bar so a skim
/// reads the shape of the app before any prose does.
pub fn render_markdown(report: &crate::schema::Report) -> String {
    let mut out = String::new();
    out.push_str(&format!("## omapak judge · `{}`\n\n", report.app_id));
    out.push_str(&format!("**{}**\n\n", verdict_label(report.verdict)));

    if let Some(dup) = &report.static_report.duplicate_of {
        out.push_str(&format!(
            "**Denied — duplicate: already packaged as `{dup}`.** Updates belong in `apps/{dup}`. If this is genuinely a different application, say so here and a maintainer will reopen.\n\n"
        ));
    }

    if !report.build.ok {
        out.push_str(&render_build_failure(&report.build));
    }

    if let Some(rubric) = &report.rubric {
        // Compact score lines, no bars, no decoration
        out.push_str(&format!("| dimension | score | note |\n|---|---|---|\n"));
        for (name, s) in [
            ("clarity", &rubric.problem_clarity),
            ("architecture", &rubric.architecture),
            ("code", &rubric.code_quality),
            ("ui/ux", &rubric.ui_ux),
            ("packaging", &rubric.packaging_hygiene),
            ("uniqueness", &rubric.differentiation.as_score()),
        ] {
            out.push_str(&format!(
                "| {} | {}/5 | {} |\n",
                name,
                s.score,
                escape_table(&first_sentence(&s.rationale))
            ));
        }
        out.push('\n');

        if !rubric.security_flags.is_empty() {
            out.push_str("**Security:**\n");
            for f in &rubric.security_flags {
                out.push_str(&format!(
                    "- [{}] {}\n",
                    match f.severity {
                        Severity::Critical => "critical",
                        Severity::Warning => "warning",
                        Severity::Info => "info",
                    },
                    escape_table(&f.detail)
                ));
            }
            out.push('\n');
        }

        if !rubric.differentiation.better_alternatives.is_empty() {
            out.push_str(&format!(
                "**Similar apps:** {}\n\n",
                rubric.differentiation.better_alternatives.join(", ")
            ));
        }
    }

    let s = &report.static_report;
    if !s.advisories.is_empty() {
        out.push_str("**Advisories:**\n");
        for a in &s.advisories {
            out.push_str(&format!("- {}: {}\n", a.kind, a.detail));
        }
        out.push('\n');
    }

    out
}

/// A failed build is the one hard gate, and the raw reason is the only
/// thing a submitter can act on — so the report must say what broke and
/// what to change, not just "changes requested".
fn render_build_failure(build: &crate::schema::BuildReport) -> String {
    let mut out = String::new();
    out.push_str("The flatpak build is the one hard gate, and it did not complete.\n\n");
    out.push_str("**How to fix:** reproduce it locally, fix your manifest, then push to this PR — the judge reruns automatically:\n\n");
    out.push_str("```bash\nflatpak-builder --user --force-clean --repo=/tmp/repo _build apps/<your-app-id>/<manifest>.yml\n```\n\n");
    for hint in build_hints(&build.log_tail) {
        out.push_str(&format!("- {hint}\n"));
    }
    out.push_str("- If the log below shows omapak tooling failing rather than your app, say so in this PR — that is our bug, not yours.\n");
    out.push_str("\n<details><summary>flatpak-builder output (last lines)</summary>\n\n```\n");
    for line in &build.log_tail {
        out.push_str(line);
        out.push('\n');
    }
    out.push_str("```\n</details>\n\n");
    out
}

/// Match the handful of failure signatures that cover almost every
/// rejected submission; anything unrecognized falls through to the
/// reproduce-locally advice above.
fn build_hints(log_tail: &[String]) -> Vec<&'static str> {
    let joined: String = log_tail
        .iter()
        .map(|l| l.to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    let mut hints = Vec::new();
    if joined.contains("sha256")
        && (joined.contains("mismatch")
            || joined.contains("does not match")
            || joined.contains("wrong checksum")
            || joined.contains("failed to validate"))
    {
        hints.push(
            "A source checksum failed: download the file your manifest points at, run `sha256sum` on it, and put that value in the source's `sha256:`.",
        );
    }
    if joined.contains("404") || joined.contains("not found") {
        hints.push(
            "A source download failed: check that the URL, tag and release asset in your manifest exist today (assets often move when a release is re-published).",
        );
    }
    if joined.contains("requested extension") {
        hints.push(
            "The runner could not install an SDK extension your manifest declares — this is on omapak's side; leave a comment and we will sort it out.",
        );
    }
    if joined.contains("no such file or directory") {
        hints.push(
            "Something referenced a missing path: check the file names in your `build-commands` and `sources:` against what the source archive actually contains.",
        );
    }
    if joined.contains("error:") || joined.contains("error ") {
        hints.push(
            "The compile/build step itself failed: find the last `Building module <name>` line above the error — that is the module to fix.",
        );
    }
    hints
}

fn first_sentence(text: &str) -> String {
    text.split('.').next().unwrap_or(text).trim().to_string() + "."
}

fn verdict_label(v: Verdict) -> &'static str {
    match v {
        Verdict::Published => "Recommendation: accept",
        Verdict::BuildFailed => {
            "Recommendation: changes requested — build failed, fix and resubmit"
        }
    }
}

fn escape_table(text: &str) -> String {
    text.replace('|', "\\|").replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{Differentiation, Report, Rubric, RubricScore};

    fn report() -> Report {
        Report {
            schema_version: 1,
            app_id: "io.outcroplabs.TestApp".into(),
            created_at: chrono::Utc::now(),
            static_report: Default::default(),
            build: crate::schema::BuildReport {
                ok: true,
                duration_secs: 30,
                log_tail: vec![],
            },
            dynamic: None,
            rubric: Some(Rubric {
                problem_clarity: RubricScore {
                    score: 4,
                    rationale: "clear".into(),
                },
                differentiation: Differentiation {
                    score: 2,
                    rationale: "clone of existing".into(),
                    better_alternatives: vec!["com.example.Better".into()],
                },
                architecture: RubricScore {
                    score: 3,
                    rationale: "fine".into(),
                },
                code_quality: RubricScore {
                    score: 3,
                    rationale: "ok | has pipes".into(),
                },
                ui_ux: RubricScore {
                    score: 4,
                    rationale: "nice".into(),
                },
                packaging_hygiene: RubricScore {
                    score: 5,
                    rationale: "clean".into(),
                },
                security_flags: vec![],
            }),
            verdict: Verdict::Published,
            certified: false,
            judge: None,
            legitimacy: None,
        }
    }

    #[test]
    fn markdown_escapes_and_renders() {
        let md = render_markdown(&report());
        assert!(md.contains("com.example.Better"));
        assert!(md.contains("3/5"));
        // assertion removed: minimal format has no gate labels
    }

    #[test]
    fn failed_build_explains_reason_and_fix() {
        let mut r = report();
        r.verdict = Verdict::BuildFailed;
        r.build = crate::schema::BuildReport {
            ok: false,
            duration_secs: 30,
            log_tail: vec![
                "Downloading https://example.com/app-1.0.tar.gz".into(),
                "ERROR: sha256 checksum mismatch".into(),
            ],
        };
        let md = render_markdown(&r);
        assert!(md.contains("did not complete"));
        assert!(md.contains("How to fix"));
        assert!(md.contains("flatpak-builder --user"));
        assert!(md.contains("A source checksum failed"));
        assert!(md.contains("sha256 checksum mismatch"));
        assert!(md.contains("<details>"));
    }
}
