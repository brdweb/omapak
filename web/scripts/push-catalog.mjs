#!/usr/bin/env node
// Builds catalog.json from apps/ and pushes it to R2 so the site reads
// live data from the CDN — no redeploy needed for app changes.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const tmp = "/tmp/omapak-catalog";

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CF_ACCOUNT || "7396d8475acc6c87ef13e97a617712f1";

// Build the catalog (same logic as build-catalog but writes to tmp)
mkdirSync(join(tmp, "reports"), { recursive: true });
const entries = [];

for (const name of readdirSync(join(root, "apps"))) {
  const appDir = join(root, "apps", name);
  const metaPath = join(appDir, "metadata.yml");
  const reportPath = join(appDir, "report.json");
  if (!existsSync(metaPath)) continue;

  let meta;
  try { meta = parseYaml(readFileSync(metaPath, "utf8")); } catch { continue; }
  if (!meta?.submitter || !meta?.source_repo || !meta?.summary) continue;

  const files = readdirSync(appDir);
  const xmlFile = files.find(f => f.endsWith(".metainfo.xml") || f.endsWith(".appdata.xml"));
  if (xmlFile) {
    const xml = readFileSync(join(appDir, xmlFile), "utf8");
    const pick = (re) => { const m = xml.match(re); return m ? m[1].trim() : null; };
    meta.name = pick(/<name>([^<]+)<\/name>/) || meta.name;
    meta.summary = pick(/<summary>([^<]+)<\/summary>/) || meta.summary;
    meta.developer = pick(/<developer[^>]*>[\s\S]*?<name>([^<]+)<\/name>/) || null;
    const dm = xml.match(/<description>([\s\S]*?)<\/description>/);
    if (dm) {
      const blocks = [];
      const parts = dm[1].split(/(<\/?(?:p|ul|li)>)/);
      let list = null, para = null;
      for (const p of parts) {
        const t = p.trim();
        if (t === "<p>") para = "";
        else if (t === "</p>") { if (para) blocks.push(para); para = null; }
        else if (t === "<ul>") list = [];
        else if (t === "</ul>") { if (list) blocks.push(list); list = null; }
        else if (t === "<li>") { if (list) list.push(""); }
        else if (t === "</li>") continue;
        else if (t && !t.startsWith("<")) {
          const text = t.replace(/<[^>]+>/g, "").trim();
          if (!text) continue;
          if (list) list[list.length - 1] = text;
          else if (para !== null) para = text;
        }
      }
      meta.description = blocks.length ? blocks : meta.description;
    }
    meta.urls = {};
    for (const m of xml.matchAll(/<url type="([^"]+)">([^<]+)<\/url>/g)) meta.urls[m[1]] = m[2].trim();
    meta.homepage = meta.urls.homepage || meta.homepage;
    meta.screenshots = [...xml.matchAll(/<image[^>]*>([^<]+)<\/image>/g)].map(m => m[1].trim());
    meta.icon = pick(/<icon[^>]*>([^<]+)<\/icon>/) || null;
  }

  let report = null;
  // Prefer the LIVE report from R2 (kept fresh by judge-report on every
  // run); fall back to a committed report.json if the fetch fails.
  if (CF_TOKEN) {
    try {
      const res = await fetch(`https://repo.omapak.org/reports/${name}.json`);
      if (res.ok) report = await res.json();
    } catch {}
  }
  if (!report && existsSync(reportPath)) {
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch {}
  }

  const appId = report?.app_id ?? name;
  // Icons live at the repo URL — publish's icon-extract step pushes one
  // for every successfully built app; metainfo <icon> tags are usually
  // stock names or absent and never point at anything fetchable.
  const fallbackName = appId
    .split(".")
    .at(-1)
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  const friendly = (meta.name || fallbackName).replace(/\b\w/g, (c) => c.toUpperCase());
  entries.push({
    app_id: appId,
    name: friendly,
    icon: `https://repo.omapak.org/icons/${appId}.png`,
    developer: meta.developer || null,
    description: meta.description || null,
    urls: meta.urls || {},
    screenshots: meta.screenshots || [],
    summary: meta.summary,
    submitter: meta.submitter,
    source_repo: meta.source_repo,
    license: meta.license,
    homepage: meta.homepage,
    tags: meta.tags ?? [],
    source_access: meta.source_access ?? "public",
    verdict: report?.verdict ?? "published",
    certified: report?.certified ?? false,
    report_available: report !== null,
  });
}

writeFileSync(join(tmp, "catalog.json"), JSON.stringify({
  generated_at: new Date().toISOString(),
  entries: entries.sort((a, b) => a.app_id.localeCompare(b.app_id)),
}, null, 2));

// Push to R2 via the Cloudflare API (rclone is gone from CI runners and
// its S3 uploads fail against R2; the API PUT is the same path the icon
// uploads below already use).
if (!CF_TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN not set, skipping push");
  process.exit(0);
}
const catalogRes = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/r2/buckets/omapak-repo/objects/data/catalog.json`,
  {
    method: "PUT",
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
    body: readFileSync(join(tmp, "catalog.json")),
  },
);
if (!catalogRes.ok) {
  console.error(`catalog push failed: ${catalogRes.status}`);
  process.exit(1);
}
console.log(`catalog pushed: ${entries.length} apps`);

// Push icons to R2 (non-blocking: failures warn, never kill)
const iconsDir = resolve(here, "../static/icons");

if (CF_TOKEN && existsSync(iconsDir)) {
  for (const file of readdirSync(iconsDir)) {
    if (!file.endsWith(".png") && !file.endsWith(".svg")) continue;
    try {
      const buf = readFileSync(join(iconsDir, file));
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/r2/buckets/omapak-repo/objects/icons/${file}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${CF_TOKEN}` },
          body: buf,
        }
      );
      if (res.ok) console.log(`  icon pushed: ${file}`);
      else console.warn(`  icon push failed (${res.status}): ${file}`);
    } catch (e) {
      console.warn(`  icon push error: ${file}: ${e.message}`);
    }
  }
} else {
  console.log("icons: skipped (no CLOUDFLARE_API_TOKEN)");
}
