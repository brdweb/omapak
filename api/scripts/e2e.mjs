#!/usr/bin/env node
// End-to-end exercise of the v1 API against a running `wrangler dev` with
// ALLOW_DEV_LINKS=1 (see api/README.md → Local development). Covers the whole
// contract: catalog listing/detail, categories, featured, magic-link auth,
// profile, review upsert/delete, aggregates, rate limiting, OpenAPI.
//
//   cd api && bun run e2e            # expects the dev server on :8787
//   API_BASE=http://localhost:8787 bun run e2e
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.API_BASE ?? "http://localhost:8787";
const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function json(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { res, body };
}

console.log(`e2e against ${BASE}\n`);

// 1. health
{
  const { res, body } = await json("/healthz");
  check("GET /healthz → 200 ok", res.status === 200 && body?.ok === true);
}

// 2. apps list — contract fields on every entry
{
  const { res, body } = await json("/v1/apps?source=omapak");
  check("GET /v1/apps?source=omapak → 200", res.status === 200, `status ${res.status}`);
  check("apps non-empty (local R2 seeded)", (body?.apps?.length ?? 0) > 0);
  const a = body?.apps?.[0];
  check(
    "AppSummary fields present",
    a && ["app_id", "source", "name", "summary", "icon", "developer", "license", "category", "tags", "rating"].every((k) => k in a),
    JSON.stringify(a)?.slice(0, 200),
  );
  check("omapak entries carry source=omapak + verdict", a?.source === "omapak" && typeof a?.verdict === "string");
  check("category is a taxonomy id", typeof a?.category === "string" && a.category.length > 0);
  check("categories array with counts", Array.isArray(body?.categories) && body.categories.length > 0 && body.categories[0].count > 0);
  check("server counts present", typeof body?.counts?.omapak === "number" && typeof body?.counts?.flathub === "number" && body.counts.all === body.counts.omapak + body.counts.flathub);
  const all = await json("/v1/apps?limit=5000");
  check("full list at limit=5000 is not truncated", all.body.apps.length === all.body.total, `${all.body.apps.length}/${all.body.total}`);
  check("limit respected", (await json("/v1/apps?limit=3")).body.apps.length <= 3);
  const q = encodeURIComponent("flatpak");
  check("q filter narrows or empties cleanly", typeof (await json(`/v1/apps?q=${q}`)).body.total === "number");
  // Regression: a catalog entry without a summary once 500'd every search —
  // the predicate must fail through per-record, and summary must stay a string.
  const noMatch = await json(`/v1/apps?q=${encodeURIComponent("zzz-no-such-app")}`);
  check("q with no matches → 200 (fail-through, not 500)", noMatch.res.status === 200 && noMatch.body?.total === 0, `status ${noMatch.res.status}`);
  check("every summary is a string", all.body.apps.every((a) => typeof a.summary === "string"));
}

// 3. flathub source + search/category filters
{
  const { body } = await json("/v1/apps?source=flathub&limit=5");
  check("flathub source lists flathub apps", (body?.apps ?? []).every((a) => a.source === "flathub"));
  check("flathub apps categorize", (body?.apps ?? []).every((a) => typeof a.category === "string"));
  const { body: cat } = await json("/v1/apps?source=flathub&category=audiovideo&limit=1");
  check("category filter applies", cat.total === 0 || cat.apps.every((a) => a.category === "audiovideo"));
}

// 4. detail + 404
{
  const list = (await json("/v1/apps?source=omapak&limit=1")).body.apps;
  const id = list?.[0]?.app_id;
  const { res, body } = await json(`/v1/apps/${id}`);
  check("GET /v1/apps/:id → 200 detail", res.status === 200 && body?.app_id === id && typeof body?.install === "string");
  const missing = await json("/v1/apps/does.not.Exist");
  check("unknown app → 404", missing.res.status === 404);
}

// 5. categories + featured + openapi
{
  const { body } = await json("/v1/categories");
  check("GET /v1/categories → counts desc", (body?.categories ?? []).every((c, i, arr) => i === 0 || arr[i - 1].count >= c.count));
  const { res: fRes, body: fBody } = await json("/v1/featured");
  check(
    "GET /v1/featured → hero + 4 grid picks + reason",
    fRes.status === 200 && typeof fBody?.hero === "string" && Array.isArray(fBody?.more) && fBody.more.length === 4 && typeof fBody?.reason === "string",
    JSON.stringify(fBody)?.slice(0, 120),
  );
  check(
    "featured slate has no duplicates",
    new Set([fBody?.hero, ...(fBody?.more ?? [])]).size === 1 + (fBody?.more?.length ?? 0),
  );
  const again = await json("/v1/featured");
  check("slate is stable within the hour", again.body?.hero === fBody?.hero && JSON.stringify(again.body?.more) === JSON.stringify(fBody?.more));
  const spec = await json("/v1/openapi.json");
  const paths = spec.body?.paths ?? {};
  const expected = ["/v1/apps", "/v1/apps/{app_id}", "/v1/apps/{app_id}/reviews", "/v1/reviews/{id}", "/v1/categories", "/v1/featured", "/v1/auth/magic-link", "/v1/auth/verify", "/v1/auth/logout", "/v1/me"];
  check("openapi covers every route", expected.every((p) => p in paths), `missing: ${expected.filter((p) => !(p in paths)).join(", ")}`);
}

// 6. auth: unauthenticated review POST → 401
{
  const id = (await json("/v1/apps?source=omapak&limit=1")).body.apps[0].app_id;
  const { res } = await json(`/v1/apps/${id}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rating: 5, body: "sneaky" }),
  });
  check("POST review without session → 401", res.status === 401);
  check("GET /v1/me without session → 401", (await json("/v1/me")).res.status === 401);
}

// 7. magic link flow (dev mode returns dev_link)
const EMAIL = `e2e-${Date.now()}@example.com`;
let cookie = "";
{
  const bad = await json("/v1/auth/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  check("magic-link with bad email → 400", bad.res.status === 400);

  const { res, body } = await json("/v1/auth/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL }),
  });
  check("magic-link request → 202 with dev_link", res.status === 202 && typeof body?.dev_link === "string", JSON.stringify(body));
  check("dev_link points at verify", body.dev_link?.includes("/v1/auth/verify?token="));

  const verify = await fetch(body.dev_link, { redirect: "manual" });
  const setCookie = verify.headers.get("set-cookie") ?? "";
  check("verify → 302 to site callback", verify.status === 302 && (verify.headers.get("location") ?? "").includes("/auth/callback"));
  check("verify sets oma_session cookie", setCookie.includes("oma_session=") && setCookie.includes("HttpOnly"));
  cookie = setCookie.split(";")[0];

  // token is single-use
  const replay = await fetch(body.dev_link, { redirect: "manual" });
  check("magic link is single-use", replay.status === 302 && (replay.headers.get("location") ?? "").includes("error=invalid"));

  const me = await json("/v1/me", { headers: { cookie } });
  check("GET /v1/me with cookie → user", me.res.status === 200 && me.body?.email === EMAIL, JSON.stringify(me.body));
}

// 8. profile
{
  const { res, body } = await json("/v1/me", {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ display_name: "E2E Tester" }),
  });
  check("PATCH /v1/me display_name", res.status === 200 && body?.display_name === "E2E Tester");
}

// 9. reviews: post → read → upsert → aggregate → delete
const APP_ID = (await json("/v1/apps?source=omapak&limit=1")).body.apps[0].app_id;
{
  const unknown = await json("/v1/apps/no.such.app/reviews", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ rating: 5 }),
  });
  check("review on unknown app → 404", unknown.res.status === 404);

  const badRating = await json(`/v1/apps/${APP_ID}/reviews`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ rating: 9 }),
  });
  check("rating 9 → 400", badRating.res.status === 400);

  const post = await json(`/v1/apps/${APP_ID}/reviews`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ rating: 5, body: "works great" }),
  });
  check("POST review → 201", post.res.status === 201 && post.body?.rating === 5 && post.body?.author?.display_name === "E2E Tester");

  const upsert = await json(`/v1/apps/${APP_ID}/reviews`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ rating: 3, body: "edited: it's fine" }),
  });
  const list = await json(`/v1/apps/${APP_ID}/reviews`);
  check("second POST upserts (still one review)", upsert.res.status === 201 && list.body.reviews.length === 1 && list.body.reviews[0].rating === 3);
  check("aggregate matches", list.body.rating?.count === 1 && list.body.rating?.average === 3, JSON.stringify(list.body.rating));

  const appsList = await json(`/v1/apps?q=${encodeURIComponent(APP_ID.split(".").pop())}&limit=2000`);
  const withRating = appsList.body.apps.find((a) => a.app_id === APP_ID);
  check("aggregate visible in /v1/apps", withRating?.rating?.count === 1 && withRating?.rating?.average === 3);

  const del = await json(`/v1/reviews/${list.body.reviews[0].id}`, { method: "DELETE", headers: { cookie } });
  check("DELETE own review → 204", del.res.status === 204);
  const after = await json(`/v1/apps/${APP_ID}/reviews`);
  check("review gone", after.body.reviews.length === 0);
  check("DELETE again → 404", (await json(`/v1/reviews/${list.body.reviews[0].id}`, { method: "DELETE", headers: { cookie } })).res.status === 404);
}

// 10. rate limiting: same email 6+ times inside the window → 429
{
  let last = 0;
  for (let i = 0; i < 7; i++) {
    const r = await json("/v1/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `spam-${EMAIL}` }),
    });
    last = r.res.status;
  }
  check("magic-link spam → 429", last === 429, `last status ${last}`);
}

// 10b. internal install counter (repo proxy ingest)
{
  // dev server has no PROXY_TOKEN → endpoint disabled
  const off = await fetch(`${BASE}/internal/installs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID }),
  });
  check("internal ingest disabled without PROXY_TOKEN → 404", off.status === 404);
}
// 11. CORS preflight from the configured site origin
{
  const pre = await fetch(`${BASE}/v1/apps`, {
    method: "OPTIONS",
    headers: { origin: "http://localhost:5217", "access-control-request-method": "GET", "access-control-request-headers": "content-type" },
  });
  check(
    "preflight from the site origin allowed",
    pre.status === 204 && pre.headers.get("access-control-allow-origin") === "http://localhost:5217" && pre.headers.get("access-control-allow-credentials") === "true",
  );
  const rogue = await fetch(`${BASE}/v1/apps`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
  });
  check("preflight from unknown origin gets no ACAO", rogue.headers.get("access-control-allow-origin") === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
