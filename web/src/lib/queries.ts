import { createQuery } from "@tanstack/svelte-query";
import type { Catalog, FlathubIndex, Report } from "./report";

// "no-cache" always revalidates with the origin: the worker once served
// these files with a one-year immutable header, and any browser holding
// that cached copy would never see another catalog or report again.
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export function useCatalog() {
  return createQuery({
    queryKey: ["catalog"],
    queryFn: () => fetchJson<Catalog>("https://repo.omapak.org/data/catalog.json").catch(() => fetchJson<Catalog>("/data/catalog.json")),
    staleTime: Infinity,
  });
}

export function useFlathub() {
  return createQuery({
    queryKey: ["flathub"],
    queryFn: () => fetchJson<FlathubIndex>("/data/flathub.json"),
    staleTime: Infinity,
    retry: 1,
  });
}

export function useReport(appId: string) {
  return createQuery({
    queryKey: ["report", appId],
    // Live reports are pushed to R2 by judge-report; the static copy is
    // only a build-time fallback.
    queryFn: () =>
      fetchJson<Report>(`https://repo.omapak.org/reports/${appId}.json`)
        .catch(() => fetchJson<Report>(`/data/reports/${appId}.json`)),
    staleTime: Infinity,
    retry: 1,
  });
}
