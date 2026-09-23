import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { currentUser, logoutResponse, requestMagicLink, verifyMagicLink } from "./auth";
import { openapi } from "./openapi";
import { readCatalog, readFlathubIndex } from "./data";
import { CATEGORY_LABELS, categorizeByAppstream, categorizeByTags } from "./categories";
import type {
  AppDetail,
  AppSource,
  AppSummary,
  CatalogEntry,
  CategoryCount,
  CategoryId,
  FlathubEntry,
  Rating,
  Review,
  UserRow,
} from "./types";
import { intParam, iso } from "./util";

/**
 * api.omapak.org — the one data contract the website and the future desktop
 * app both populate from. Catalog bytes come from the omapak-repo R2 bucket
 * (same objects repo.omapak.org serves); accounts and reviews live in D1.
 * See api/README.md for the contract and /v1/openapi.json for the schema.
 */

const app = new Hono<{ Bindings: Env }>();

// Cookie-carrying cross-site fetches from omapak.org (and localhost dev).
const devOrigins = ["http://localhost:5173", "http://localhost:5217", "http://localhost:4173", "http://localhost:4319"];

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const extra = ((c.env as Env).EXTRA_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const allowed = [(c.env as Env).SITE_ORIGIN, ...devOrigins, ...extra];
      return allowed.includes(origin) ? origin : undefined;
    },
    allowHeaders: ["content-type", "authorization"],
    credentials: true,
    maxAge: 86400,
  }),
);

app.get("/healthz", (c) => c.json({ ok: true }));

// ── Store model ─────────────────────────────────────────────────────────────

function omapakSummary(entry: CatalogEntry): AppSummary {
  return {
    app_id: entry.app_id,
    source: "omapak",
    name: entry.name || entry.app_id,
    // The catalog schema dropped summary once (push-catalog.mjs) and every
    // summary-less record 500'd /v1/apps?q=… — the contract here is a string.
    summary: entry.summary ?? "",
    icon: entry.icon ?? null,
    developer: entry.developer ?? null,
    license: entry.license ?? null,
    category: categorizeByTags(entry.tags ?? []),
    tags: entry.tags ?? [],
    rating: null,
    verdict: entry.verdict ?? "unpublished",
    certified: entry.certified ?? false,
    advisory_average: entry.advisory_average,
    report_available: entry.report_available ?? false,
  };
}

function flathubSummary(entry: FlathubEntry): AppSummary {
  return {
    app_id: entry.app_id,
    source: "flathub",
    name: entry.name || entry.app_id,
    summary: entry.summary ?? "",
    icon: entry.icon ?? null,
    developer: null,
    license: entry.license ?? null,
    category: categorizeByAppstream(entry.categories ?? []),
    tags: entry.categories ?? [],
    rating: null,
  };
}

/** omapak apps + flathub apps not already hosted here, in store order. */
async function loadSummaries(env: Env): Promise<{ omapak: AppSummary[]; flathub: AppSummary[] }> {
  const [catalog, flathub] = await Promise.all([readCatalog(env), readFlathubIndex(env)]);
  const omapak = (catalog?.entries ?? []).map(omapakSummary);
  const hosted = new Set(omapak.map((a) => a.app_id));
  const passthrough = (flathub?.apps ?? [])
    .filter((a) => !hosted.has(a.app_id))
    .map(flathubSummary);
  return { omapak, flathub: passthrough };
}

async function ratingAggregates(db: D1Database, appIds: string[]): Promise<Map<string, Rating>> {
  const out = new Map<string, Rating>();
  for (let i = 0; i < appIds.length; i += 100) {
    const slice = appIds.slice(i, i + 100);
    const placeholders = slice.map((_, j) => `?${j + 1}`).join(", ");
    const rows = await db
      .prepare(`SELECT app_id, AVG(rating) AS average, COUNT(*) AS count FROM reviews WHERE app_id IN (${placeholders}) GROUP BY app_id`)
      .bind(...slice)
      .all<{ app_id: string; average: number; count: number }>();
    for (const row of rows.results) {
      out.set(row.app_id, { average: Math.round(row.average * 10) / 10, count: row.count });
    }
  }
  return out;
}

function countCategories(summaries: AppSummary[]): CategoryCount[] {
  const counts = new Map<CategoryId, number>();
  for (const a of summaries) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: CATEGORY_LABELS[id], count }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

async function appExists(env: Env, appId: string): Promise<AppSource | null> {
  const { omapak, flathub } = await loadSummaries(env);
  if (omapak.some((a) => a.app_id === appId)) return "omapak";
  if (flathub.some((a) => a.app_id === appId)) return "flathub";
  return null;
}

// ── Endpoints ───────────────────────────────────────────────────────────────

const v1 = new Hono<{ Bindings: Env }>();

v1.get("/apps", async (c) => {
  const source = (c.req.query("source") ?? "all") as "all" | "omapak" | "flathub";
  const category = c.req.query("category") ?? "";
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const limit = intParam(c.req.query("limit"), 500, 1, 5000);
  const offset = intParam(c.req.query("offset"), 0, 0, 1_000_000);

  const { omapak, flathub } = await loadSummaries(c.env);
  const bySource =
    source === "omapak" ? omapak : source === "flathub" ? flathub : [...omapak, ...flathub];

  // Category chips count within the current source, ignoring the live search
  // box, so counts don't jump while typing.
  const categories = countCategories(bySource);

  let filtered = bySource;
  if (category) filtered = filtered.filter((a) => a.category === category);
  if (q) {
    filtered = filtered.filter(
      (a) =>
        (a.app_id ?? "").toLowerCase().includes(q) ||
        (a.name ?? "").toLowerCase().includes(q) ||
        (a.summary ?? "").toLowerCase().includes(q),
    );
  }

  const page = filtered.slice(offset, offset + limit);
  const ratings = await ratingAggregates(c.env.DB, page.map((a) => a.app_id));
  for (const a of page) a.rating = ratings.get(a.app_id) ?? null;

  // Server-truth counts: stable no matter the page window, so clients can
  // label totals without guessing at pagination truncation.
  return c.json({
    total: filtered.length,
    counts: { omapak: omapak.length, flathub: flathub.length, all: omapak.length + flathub.length },
    apps: page,
    categories,
  });
});

v1.get("/apps/:id", async (c) => {
  const id = c.req.param("id");
  const [catalog, flathubIndex] = await Promise.all([readCatalog(c.env), readFlathubIndex(c.env)]);

  const entry = catalog?.entries.find((e) => e.app_id === id);
  const hostedIds = new Set((catalog?.entries ?? []).map((e) => e.app_id));
  const flathubEntry = !entry && !hostedIds.has(id) ? flathubIndex?.apps.find((a) => a.app_id === id) : undefined;

  let detail: AppDetail | null = null;
  if (entry) {
    detail = {
      ...omapakSummary(entry),
      description: entry.description ?? null,
      homepage: entry.homepage ?? null,
      source_repo: entry.source_repo ?? null,
      bugtracker: entry.bugtracker ?? null,
      screenshots: entry.screenshots ?? [],
      install: `flatpak install omapak ${id}`,
      report_url: entry.report_available ? `https://repo.omapak.org/reports/${id}.json` : null,
    };
  } else if (flathubEntry) {
    detail = {
      ...flathubSummary(flathubEntry),
      description: null,
      homepage: null,
      source_repo: null,
      bugtracker: null,
      screenshots: [],
      install: `flatpak install omapak ${id}`,
    };
  }
  if (!detail) return c.json({ error: "app not found" }, 404);

  const [rating] = [...(await ratingAggregates(c.env.DB, [id])).values()];
  detail.rating = rating ?? null;
  return c.json(detail);
});

// ── Reviews ─────────────────────────────────────────────────────────────────

interface ReviewRow {
  id: number;
  app_id: string;
  user_id: number;
  rating: number;
  body: string;
  created_at: string;
  updated_at: string;
  display_name: string | null;
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    app_id: row.app_id,
    user_id: row.user_id,
    rating: row.rating,
    body: row.body,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    author: { display_name: row.display_name ?? "omapak user" },
  };
}

const REVIEW_SELECT = `SELECT r.id, r.app_id, r.user_id, r.rating, r.body, r.created_at, r.updated_at, u.display_name
  FROM reviews r JOIN users u ON u.id = r.user_id`;

v1.get("/apps/:id/reviews", async (c) => {
  const id = c.req.param("id");
  if (!(await appExists(c.env, id))) return c.json({ error: "app not found" }, 404);

  const limit = intParam(c.req.query("limit"), 20, 1, 50);
  const offset = intParam(c.req.query("offset"), 0, 0, 1_000_000);
  const rows = await c.env.DB.prepare(`${REVIEW_SELECT} WHERE r.app_id = ?1 ORDER BY r.created_at DESC, r.id DESC LIMIT ?2 OFFSET ?3`)
    .bind(id, limit, offset)
    .all<ReviewRow>();

  const [rating] = [...(await ratingAggregates(c.env.DB, [id])).values()];
  return c.json({
    app_id: id,
    rating: rating ?? null,
    reviews: rows.results.map(toReview),
  });
});

v1.post("/apps/:id/reviews", async (c) => {
  const user = await currentUser(c, c.env);
  if (!user) return c.json({ error: "sign in to review" }, 401);

  const id = c.req.param("id");
  if (!(await appExists(c.env, id))) return c.json({ error: "app not found" }, 404);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
  const rating = (body as { rating?: unknown }).rating;
  const text = (body as { body?: unknown }).body ?? "";
  if (!Number.isInteger(rating) || (rating as number) < 1 || (rating as number) > 5) {
    return c.json({ error: "rating must be an integer 1–5" }, 400);
  }
  if (typeof text !== "string" || text.length > 4000) {
    return c.json({ error: "review text must be at most 4000 characters" }, 400);
  }

  // One review per user per app: posting again edits in place.
  await c.env.DB.prepare(
    `INSERT INTO reviews (app_id, user_id, rating, body) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (app_id, user_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, updated_at = datetime('now')`,
  )
    .bind(id, user.id, rating, text.trim())
    .run();

  const row = await c.env.DB.prepare(`${REVIEW_SELECT} WHERE r.app_id = ?1 AND r.user_id = ?2`)
    .bind(id, user.id)
    .first<ReviewRow>();
  return c.json(toReview(row!), 201);
});

v1.delete("/reviews/:id", async (c) => {
  const user = await currentUser(c, c.env);
  if (!user) return c.json({ error: "sign in first" }, 401);

  const res = await c.env.DB.prepare("DELETE FROM reviews WHERE id = ?1 AND user_id = ?2")
    .bind(Number(c.req.param("id")), user.id)
    .run();
  if (!res.meta.changes) return c.json({ error: "review not found" }, 404);
  return c.body(null, 204);
});

// ── Categories & featured ───────────────────────────────────────────────────

v1.get("/categories", async (c) => {
  const { omapak, flathub } = await loadSummaries(c.env);
  return c.json({ categories: countCategories([...omapak, ...flathub]) });
});

/**
 * Featured slate: one hero + four grid picks, randomized hourly, weighted so
 * quality rises and popularity compounds. Every eligible app (published,
 * icon'd omapak entries) carries a weight:
 *
 *   judge advisory 0–5            → base, so empty store still ranks by quality
 *   +2 when certified             → hard gates matter
 *   + review signal, capped at 3  → community ratings, damped so a single
 *                                    5★ rating can't hijack the slot:
 *                                    signal = average/5 × min(ratings, 12)
 *   + installs, log-damped, ≤3    → ref resolutions counted by the repo
 *                                    proxy: 2^(1/4) growth per ~20%, so
 *                                    10→+1, 100→+2, 1000→+3
 *
 * Weighted sampling without replacement picks 5 (hero first). The hour-seeded
 * PRNG makes the slate deterministic for an hour — the desktop app and every
 * browser agree on it — then re-rolls.
 */
v1.get("/featured", async (c) => {
  const { omapak } = await loadSummaries(c.env);
  const eligible = omapak.filter(
    (a) => a.verdict === "published" && a.icon && a.source === "omapak",
  );
  if (!eligible.length) return c.json({ error: "no apps to feature" }, 404);

  const ids = eligible.map((a) => a.app_id);
  const [ratings, installRows] = await Promise.all([
    ratingAggregates(c.env.DB, ids),
    c.env.DB.prepare(`SELECT app_id, count FROM installs WHERE app_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...ids)
      .all<{ app_id: string; count: number }>(),
  ]);
  const installs = new Map(installRows.results.map((r) => [r.app_id, r.count]));

  const weights = new Map<string, number>();
  for (const a of eligible) {
    const judge = a.advisory_average ?? 2.5;
    const cert = a.certified ? 2 : 0;
    const rating = ratings.get(a.app_id);
    const reviewSignal = rating ? (rating.average / 5) * Math.min(rating.count, 12) : 0;
    const installSignal = Math.min(3, Math.log2(1 + (installs.get(a.app_id) ?? 0)) / 2);
    weights.set(a.app_id, Math.max(0.1, judge + cert + reviewSignal + installSignal));
  }

  const hour = Math.floor(Date.now() / 3_600_000);
  const slate = weightedSample(
    eligible.map((a) => a.app_id),
    (id) => weights.get(id) ?? 0.1,
    5,
    mulberry32(hour),
  );
  if (!slate.length) return c.json({ error: "no apps to feature" }, 404);

  return c.json({ hero: slate[0], more: slate.slice(1), reason: "quality-weighted, refreshed hourly" });
});

/** Deterministic PRNG (mulberry32) — same slate for every caller this hour. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weighted sample without replacement. */
function weightedSample<T>(items: T[], weightOf: (t: T) => number, k: number, rand: () => number): T[] {
  const pool = items.slice();
  const picked: T[] = [];
  while (picked.length < k && pool.length) {
    const weights = pool.map(weightOf);
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = rand() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      roll -= weights[idx]!;
      if (roll <= 0) break;
    }
    picked.push(pool.splice(idx, 1)[0]!);
  }
  return picked;
}
// ── Internal (repo proxy) ───────────────────────────────────────────────────

/**
 * Install counter from the repo proxy (repo.omapak.org). The proxy POSTs
 * {app_id} whenever flatpak resolves one of its refs (an install or an
 * update — both mean a live user touching the app). Authenticated by the
 * shared PROXY_TOKEN secret; disabled entirely when that secret is absent.
 * Attribution is validated against the live catalog so bogus ids can't
 * manufacture rows. 204 either way: the proxy fire-and-forgets and never
 * retries, so it can't distinguish (and shouldn't care about) outcomes.
 */
app.post("/internal/installs", async (c) => {
  if (!c.env.PROXY_TOKEN) return c.body(null, 404);
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${c.env.PROXY_TOKEN}`) return c.body(null, 403);

  let appId: unknown;
  try {
    ({ app_id: appId } = (await c.req.json()) as { app_id?: unknown });
  } catch {
    return c.body(null, 400);
  }
  if (typeof appId !== "string" || !/^[A-Za-z0-9._-]+$/.test(appId)) return c.body(null, 400);

  if ((await appExists(c.env, appId)) === null) return c.body(null, 204);

  await c.env.DB.prepare(
    `INSERT INTO installs (app_id, count, first_at, last_at) VALUES (?1, 1, datetime('now'), datetime('now'))
     ON CONFLICT (app_id) DO UPDATE SET count = count + 1, last_at = datetime('now')`,
  )
    .bind(appId)
    .run();
  return c.body(null, 204);
});


v1.post("/auth/magic-link", (c) => requestMagicLink(c, c.env));
v1.get("/auth/verify", (c) => verifyMagicLink(c, c.env));
v1.post("/auth/logout", () => logoutResponse());

v1.get("/me", async (c) => {
  const user = await currentUser(c, c.env);
  if (!user) return c.json({ error: "not signed in" }, 401);
  return c.json(meOf(user));
});

v1.patch("/me", async (c) => {
  const user = await currentUser(c, c.env);
  if (!user) return c.json({ error: "not signed in" }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json body" }, 400);
  }
  const raw = (body as { display_name?: unknown }).display_name;
  if (typeof raw !== "string") return c.json({ error: "display_name is required" }, 400);
  const name = raw.replace(/\p{C}/gu, "").trim().slice(0, 40);
  if (!name) return c.json({ error: "display_name can't be empty" }, 400);

  await c.env.DB.prepare("UPDATE users SET display_name = ?1 WHERE id = ?2").bind(name, user.id).run();
  const fresh = { ...user, display_name: name };
  return c.json(meOf(fresh));
});

function meOf(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    created_at: iso(user.created_at),
  };
}

v1.get("/openapi.json", (c) => c.json(openapi()));

app.route("/v1", v1);

export default app;
