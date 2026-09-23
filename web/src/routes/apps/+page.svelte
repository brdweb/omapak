<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { writable } from "svelte/store";
  import { useApps, useAppDetail, useFeatured } from "$lib/api/queries";
  import type { AppSource } from "$lib/api/types";
  import { CATEGORY_LABELS } from "$lib/api/types";
  import AppCard from "$lib/components/AppCard.svelte";
  import RatingStars from "$lib/components/RatingStars.svelte";
  import VerdictBadge from "$lib/components/VerdictBadge.svelte";
  import Copy from "@lucide/svelte/icons/copy";
  import Check from "@lucide/svelte/icons/check";

  // Filter state lives in the URL — the store page is linkable SPA state.
  const q = $derived(page.url.searchParams.get("q") ?? "");
  const source = $derived((page.url.searchParams.get("source") ?? "all") as AppSource | "all");
  const category = $derived(page.url.searchParams.get("category") ?? "");

  // Sync reactive URL state into stores so query keys re-key live
  // (createQuery options accept a store — see lib/api/queries.ts).
  const sourceStore = writable<AppSource | "all">("all");
  $effect(() => {
    sourceStore.set(source);
  });

  const apps = useApps(sourceStore);
  const featured = useFeatured();

  const heroIdStore = writable("");
  $effect(() => {
    heroIdStore.set($featured.data?.hero ?? "");
  });
  const heroDetail = useAppDetail(heroIdStore);

  // One malformed record (e.g. a missing summary in the catalog) must cost
  // that record its match, not the whole store page — hence ?? "" everywhere.
  const filtered = $derived.by(() => {
    const needle = q.trim().toLowerCase();
    return ($apps.data?.apps ?? []).filter(
      (a) =>
        (!category || a.category === category) &&
        (!needle ||
          (a.app_id ?? "").toLowerCase().includes(needle) ||
          (a.name ?? "").toLowerCase().includes(needle) ||
          (a.summary ?? "").toLowerCase().includes(needle)),
    );
  });
  // Server-truth counts: the loaded array can be a truncated page window,
  // and counting it underreported flathub by ~1300 apps.
  const omapakCount = $derived($apps.data?.counts?.omapak ?? 0);
  const flathubCount = $derived($apps.data?.counts?.flathub ?? 0);

  function setParam(key: string, value: string) {
    const url = new URL(page.url);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    goto(`?${url.searchParams}`, { replaceState: true, keepFocus: true, noScroll: true });
  }

  let copied = $state(false);
  function copyInstall(id: string) {
    navigator.clipboard.writeText(`flatpak install omapak ${id}`);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<svelte:head>
  <title>Apps · Omapak</title>
  <meta
    name="description"
    content="Every app, one remote: omapak-hosted flatpaks graded on their merits plus the full flathub catalog, served and cached by omapak."
  />
</svelte:head>

<section class="pb-16 pt-10">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <p class="font-mono text-xs uppercase tracking-[0.2em] text-ink-dim">the store</p>
      <h1 class="mt-2 text-3xl leading-tight text-fg sm:text-4xl">
        Every app. <span class="text-accent">One remote.</span>
      </h1>
    </div>
    {#if !$apps.isPending && !$apps.isError}
      <p class="font-mono text-xs text-ink-dim">
        <span class="text-muted">{omapakCount}</span> omapak hosted ·
        <span class="text-muted">{flathubCount}</span> flathub, cached by us
      </p>
    {/if}
  </div>

  <!-- Featured hero: only shown when the pick has an icon (and a screenshot
       when one exists) — an icon-less tile up here looks broken, so the hero
       just hides rather than degrading. -->
  {#if $featured.data?.hero && !q && !category && source !== "flathub"}
    {@const hero = $heroDetail.data}
    {#if hero && hero.icon}
    <div class="relative mt-8 overflow-hidden rounded-sm border border-accent-border shadow-[var(--theme-shadow-1)]">
      {#if hero.screenshots?.length}
        <img
          src={hero.screenshots[0]}
          alt=""
              class="absolute inset-0 h-full w-full object-cover opacity-[0.07]"
          onerror={(e) => {
            (e.currentTarget as HTMLImageElement).remove();
          }}
        />
      {/if}
      <div class="relative bg-card/70 p-6 backdrop-blur-[2px] sm:p-8">
        <div class="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_auto]">
          <div class="flex min-w-0 items-start gap-5">
            <img
              src={hero.icon}
              alt=""
              class="h-20 w-20 shrink-0 rounded-xl border border-line bg-raised object-contain shadow-[var(--theme-shadow-1)]"
              onerror={(e) => {
                // The icon is a load condition for this hero: if it breaks,
                // remove the whole block rather than show a broken tile.
                (e.currentTarget as HTMLImageElement).closest("div.grid")?.parentElement?.parentElement?.remove();
              }}
            />
            <div class="min-w-0">
              <p class="font-mono text-[10px] uppercase tracking-[0.15em] text-accent">featured</p>
              <a href="/app/{hero.app_id}" class="mt-1 block text-2xl font-semibold text-fg hover:text-accent">
                {hero.name}
              </a>
              <p class="mt-2 max-w-2xl leading-relaxed text-muted">{hero.summary}</p>
              <div class="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs">
                <span class="rounded-sm border border-line-subtle bg-panel px-2 py-0.5 text-muted">
                  {CATEGORY_LABELS[hero.category]}
                </span>
                {#if hero.source === "omapak"}
                  <VerdictBadge verdict={hero.verdict ?? "unpublished"} certified={hero.certified} />
                  {#if hero.advisory_average !== undefined}
                    <span class="text-accent" title="agent-judge advisory average"
                      >judge {hero.advisory_average.toFixed(1)}/5</span
                    >
                  {/if}
                {/if}
                {#if hero.rating}
                  <span class="flex items-center gap-1.5">
                    <RatingStars value={hero.rating.average} />
                    <span class="text-muted">{hero.rating.average.toFixed(1)}</span>
                  </span>
                {/if}
              </div>
            </div>
          </div>

          <div class="flex flex-col justify-center gap-3 lg:w-72">
            <code
              class="group flex items-center justify-between gap-3 rounded-sm border border-line bg-input px-4 py-3 font-mono text-sm text-fg shadow-[var(--theme-shadow-1)]"
            >
              <span class="truncate">
                <span class="text-accent">$</span> flatpak install omapak <span class="text-muted">{hero.app_id}</span>
              </span>
              <button
                onclick={() => copyInstall(hero.app_id)}
                aria-label="Copy install command"
                title="copy"
                class="shrink-0 rounded-sm border border-line p-1.5 text-muted transition-colors hover:border-accent-border hover:text-accent"
              >
                {#if copied}<Check size={14} class="text-success" />{:else}<Copy size={14} />{/if}
              </button>
            </code>
            <a
              href="/app/{hero.app_id}"
              class="rounded-sm border border-accent-border bg-accent-soft px-4 py-2.5 text-center font-mono text-sm text-accent transition-colors hover:bg-accent hover:text-surface"
            >
              view app →</a
            >
            <p class="text-center font-mono text-[10px] text-ink-dim">{$featured.data?.reason}</p>
          </div>
        </div>
      </div>
    </div>
    {/if}
  {/if}

  <!-- Featured grid: four more weighted picks under the hero. Details come
       from the same apps listing (already in memory) — no extra requests. -->
  {#if $featured.data?.more?.length && !q && !category && source !== "flathub"}
    {@const grid = $featured.data.more
      .map((id) => ($apps.data?.apps ?? []).find((a) => a.app_id === id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a && a.icon))}
    {#if grid.length}
      <div class="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {#each grid as app (app.app_id)}
          <a
            href="/app/{app.app_id}"
            class="group flex items-center gap-3 rounded-sm border border-line bg-card p-4 shadow-[var(--theme-shadow-1)] transition-colors hover:border-line-strong hover:bg-hover"
          >
            <img
              src={app.icon}
              alt=""
              loading="lazy"
              class="h-11 w-11 shrink-0 rounded-lg border border-line-subtle bg-raised object-contain"
              onerror={(e) => {
                (e.currentTarget as HTMLImageElement).remove();
              }}
            />
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium text-fg group-hover:text-accent">{app.name}</span>
              <span class="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-ink-dim">
                {#if app.rating}
                  <RatingStars value={app.rating.average} size={11} />
                  <span class="text-muted">{app.rating.count}</span>
                {:else if app.advisory_average !== undefined}
                  <span class="text-accent">judge {app.advisory_average.toFixed(1)}</span>
                {:else}
                  <span>{CATEGORY_LABELS[app.category]}</span>
                {/if}
              </span>
            </span>
            {#if app.certified}
              <span
                class="ml-auto shrink-0 font-mono text-xs text-accent"
                title="Meets omapak Certified criteria"
                >✓</span
              >
            {/if}
          </a>
        {/each}
      </div>
    {/if}
  {/if}

  <!-- Controls -->
  <div class="mt-10 flex flex-wrap items-center gap-3 border-t border-line pt-6">
    <input
      type="search"
      value={q}
      oninput={(e) => setParam("q", (e.target as HTMLInputElement).value)}
      placeholder="search {omapakCount + flathubCount} apps…"
      class="w-64 max-w-full rounded-sm border border-line bg-input px-3 py-2 font-mono text-sm text-fg placeholder:text-ink-dim focus:border-line-strong focus:outline-none"
    />
    <div class="flex overflow-hidden rounded-sm border border-line font-mono text-xs">
      {#each ["all", "omapak", "flathub"] as s (s)}
        <button
          onclick={() => setParam("source", s === "all" ? "" : s)}
          class="px-3 py-2 transition-colors {source === s
            ? 'bg-accent-soft text-accent'
            : 'text-muted hover:text-fg'}"
        >
          {s}
        </button>
      {/each}
    </div>
  </div>

  <!-- Category chips -->
  {#if $apps.data?.categories?.length}
    <div class="mt-4 flex flex-wrap gap-2">
      <button
        onclick={() => setParam("category", "")}
        class="rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors {category
          ? 'border-line-subtle text-muted hover:border-line hover:text-fg'
          : 'border-accent-border bg-accent-soft text-accent'}"
      >
        all
      </button>
      {#each $apps.data.categories as c (c.id)}
        <button
          onclick={() => setParam("category", category === c.id ? "" : c.id)}
          class="rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors {category === c.id
            ? 'border-accent-border bg-accent-soft text-accent'
            : 'border-line-subtle text-muted hover:border-line hover:text-fg'}"
        >
          {c.label} <span class="text-ink-dim">{c.count}</span>
        </button>
      {/each}
    </div>
  {/if}

  <!-- Grid -->
  {#if $apps.isPending}
    <p class="mt-8 font-mono text-sm text-muted">loading the store…</p>
  {:else if $apps.isError}
    <p class="mt-8 font-mono text-sm text-danger">the store failed to load</p>
  {:else if filtered.length === 0}
    <p class="mt-8 max-w-[var(--read-width)] text-muted">
      Nothing matches{q ? ` “${q}”` : ""}{category ? ` in ${CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category}` : ""}.
      <button onclick={() => { setParam("q", ""); setParam("category", ""); }} class="text-accent underline underline-offset-4">clear filters</button>.
    </p>
  {:else}
    <div class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each filtered as app (app.app_id)}
        <AppCard {app} />
      {/each}
    </div>
    {#if filtered.length < ($apps.data?.total ?? 0)}
      <p class="mt-6 font-mono text-xs text-ink-dim">
        showing {filtered.length} of {$apps.data?.total} — refine the search to narrow further.
      </p>
    {/if}
  {/if}
</section>
