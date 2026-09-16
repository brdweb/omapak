#!/usr/bin/env python3
"""Daily flathub-denial sweep for omapak campaign candidates.

Looks at flathub/flathub PRs closed-unmerged in the last WINDOW hours,
filters them the way rounds 1-4 did by hand, and posts new candidates
as a comment on a standing "campaign sweep" issue (which doubles as the
dedupe ledger). Research only: no submissions, no outreach.

Filter chain, per candidate:
  1. closed + never merged + title starts with "Add"
  2. not an acceptance (flathub/<app-id> repo existing means closed on
     acceptance — Flathub closes submission PRs both ways)
  3. not already submitted to omapak (any PR state) or reported here
  4. upstream actively maintained: pushed within 365d, not archived
  5. some userbase: >= MIN_STARS GitHub stars (or an official vendor
     namespace, where stars are the wrong yardstick)
  6. origin, weak auto-check: PR author appears in the app-id or owns
     the source repo — full verification stays manual

Requires: GITHUB_TOKEN (public reads + omapak issue writes).
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

WINDOW_HOURS = 72          # overlap tolerates a missed day
MIN_STARS = 20
DIGEST_ISSUE_TITLE = "campaign sweep — flathub denial digest"
OMAPAK = "outcrop-labs/omapak"
FLATHUB = "flathub/flathub"

TOKEN = os.environ["GITHUB_TOKEN"]
HDRS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/vnd.github+json",
    "User-Agent": "omapak-campaign-sweep",
}


def api(url, tries=3):
    for attempt in range(1, tries + 1):
        req = urllib.request.Request(url, headers=HDRS)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return 404, {}
            if e.code in (403, 429) and attempt < tries:
                time.sleep(30 * attempt)
                continue
            return e.code, {}
        except urllib.error.URLError:
            if attempt < tries:
                time.sleep(10)
                continue
            return 0, {}
    return 0, {}


def flathub_prs_closed_since(hours):
    since = (datetime.now(timezone.utc) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Plain list endpoint, not search: Actions' installation token returns
    # empty results from the search API, while list endpoints work fine.
    # Closed PRs get bot-comment updates constantly, so updated-desc keeps
    # a fresh close window inside the first few pages.
    prs, page = [], 1
    while page <= 5:
        status, batch = api(
            f"https://api.github.com/repos/{FLATHUB}/pulls"
            f"?state=closed&sort=updated&direction=desc&per_page=100&page={page}"
        )
        if status != 200 or not batch:
            break
        prs.extend(batch)
        page += 1
    out = []
    for p in prs:
        if p.get("merged_at") or not p.get("closed_at") or p["closed_at"] <= since:
            continue
        if not p["title"].startswith("Add "):
            continue
        out.append(p)
    return out


def submitted_app_ids():
    ids = set()
    page = 1
    while True:
        status, prs = api(
            f"https://api.github.com/repos/{OMAPAK}/pulls"
            f"?state=all&per_page=100&page={page}"
        )
        if status != 200 or not prs:
            break
        for p in prs:
            m = re.match(r"^Add\s+(\S+)", p["title"])
            if m:
                ids.add(m.group(1).rstrip(".yml").rstrip(".yaml").rstrip(".json"))
        page += 1
        if page > 5:
            break
    return ids


def digest_issue():
    q = urllib.parse.quote(f'repo:{OMAPAK} is:issue is:open in:title "{DIGEST_ISSUE_TITLE}"')
    status, data = api(f"https://api.github.com/search/issues?q={q}")
    if status == 200:
        for item in data.get("items", []):
            if item["title"] == DIGEST_ISSUE_TITLE:
                return item["number"], item["body"] or ""
    body = (
        "Daily digest of newly denied flathub submissions that pass the "
        "campaign filters (maintained, packaged, some userbase, likely "
        "origin-developer). One comment per sweep. Research only — "
        "submissions and outreach stay manual.\n\n"
        "_Bot digest; each candidate appears once._"
    )
    req = urllib.request.Request(
        f"https://api.github.com/repos/{OMAPAK}/issues",
        data=json.dumps({"title": DIGEST_ISSUE_TITLE, "body": body}).encode(),
        headers=HDRS,
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["number"], body


def already_reported(issue_number):
    status, comments = api(
        f"https://api.github.com/repos/{OMAPAK}/issues/{issue_number}/comments?per_page=100"
    )
    text = issue_number and comments if isinstance(comments, list) else []
    body = "\n".join(c.get("body", "") for c in text) if status == 200 else ""
    return set(int(n) for n in re.findall(r"flathub#(\d+)", body))


def app_owner(app_id):
    """Owner segment of an app-id: io.github.X.Y -> X, tld.OWNER.app -> OWNER."""
    parts = app_id.split(".")
    if len(parts) >= 3 and parts[0] == "io" and parts[1] == "github":
        return parts[2]
    if len(parts) >= 3:
        return parts[1]
    return ""


def manifest_source_repo(pr_number, app_id):
    status, files = api(f"https://api.github.com/repos/{FLATHUB}/pulls/{pr_number}/files?per_page=100")
    if status != 200:
        return None
    owner = app_owner(app_id).lower()
    for f in files:
        name = f["filename"].split("/")[-1]
        if name.endswith((".yml", ".yaml", ".json")) and "flathub.json" not in name:
            try:
                with urllib.request.urlopen(
                    urllib.request.Request(f["raw_url"], headers=HDRS)
                ) as r:
                    text = r.read().decode("utf-8", "replace")
            except Exception:
                continue
            urls = re.findall(r"github\.com[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?[\"'\s]", text)
            if not urls:
                continue
            # Only trust a repo owned by the app-id's owner segment — the
            # first URL in a manifest is often just a module source
            # (shared-modules, crates) and its stars/maintenance say
            # nothing about the app.
            for o, r in urls:
                if owner and o.lower() == owner:
                    return f"{o}/{r}"
    return None


def vet(pr):
    """Return a digest line dict or None (filtered out)."""
    app_id = pr["title"][4:].strip().rstrip(".yml").rstrip(".yaml").rstrip(".json")
    if not re.match(r"^[a-z0-9]+(\.[\w-]+)+$", app_id):
        return None
    author = pr["user"]["login"]

    src = manifest_source_repo(pr["number"], app_id)
    repo_meta = None
    if src:
        status, repo_meta = api(f"https://api.github.com/repos/{src}")
        if status != 200:
            src = None
    if not src:
        return {"app_id": app_id, "pr": pr["number"], "author": author,
                "note": "no GitHub source found — manual look", "keep": "maybe"}

    stars = repo_meta["stargazers_count"]
    archived = repo_meta["archived"]
    pushed = repo_meta["pushed_at"]
    pushed_days = (datetime.now(timezone.utc) - datetime.fromisoformat(pushed)).days
    vendor_official = repo_meta["owner"]["type"] == "Organization" and stars < MIN_STARS

    if archived or pushed_days > 365:
        return None
    if stars < MIN_STARS and not vendor_official:
        return None

    origin = "weak: author in app-id or owns source"
    if author.lower() in app_id.lower() or src.split("/")[0].lower() == author.lower():
        origin = "strong: author matches source owner"
    return {
        "app_id": app_id, "pr": pr["number"], "author": author, "source": src,
        "stars": stars, "pushed_days": pushed_days, "archived": archived,
        "origin": origin, "keep": "yes",
    }


def main():
    dry = os.environ.get("SWEEP_DRY_RUN") == "1"
    prs = flathub_prs_closed_since(WINDOW_HOURS)
    if dry:
        issue_no, reported, have = 0, set(), set()
    else:
        issue_no, _ = digest_issue()
        reported = already_reported(issue_no)
        have = submitted_app_ids()

    lines = []
    for pr in prs:
        if pr["number"] in reported:
            continue
        info = vet(pr)
        if not info:
            continue
        if info["app_id"] in have:
            continue
        lines.append(info)

    print(f"window: {len(prs)} closed-unmerged Add PRs, {len(lines)} new candidates")
    if not lines:
        return

    lines.sort(key=lambda i: -(i.get("stars") or 0))
    body = [f"### Sweep {datetime.now(timezone.utc):%Y-%m-%d}\n"]
    for i in lines:  # noqa: B007
        if i["keep"] == "yes":
            body.append(
                f"- **{i['app_id']}** — flathub#{i['pr']} — {i['source']} "
                f"★{i['stars']}, pushed {i['pushed_days']}d ago — origin {i['origin']}"
            )
        else:
            body.append(
                f"- {i['app_id']} — flathub#{i['pr']} — {i.get('note', '')} (needs manual vetting)"
            )
    text = "\n".join(body)
    if dry:
        print(text)
        return
    req = urllib.request.Request(
        f"https://api.github.com/repos/{OMAPAK}/issues/{issue_no}/comments",
        data=json.dumps({"body": text}).encode(),
        headers=HDRS,
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        print(f"posted digest comment to #{issue_no}: {r.status}")


if __name__ == "__main__":
    sys.exit(main())
