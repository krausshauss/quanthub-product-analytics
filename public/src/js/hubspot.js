/**
 * hubspot.js — Product Analytics data fetching
 */
window.HubSpot = (() => {

  const BASE = () => window.CONFIG.WORKER_URL;

  async function api(path) {
    const res = await fetch(`${BASE()}${path}`, {
      headers: { "Content-Type": "application/json" },
    });
    if (res.status === 401) {
      window.location.href = "/login";
      throw new Error("Session expired");
    }
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`${path}: ${res.status} — ${err}`);
    }
    return res.json();
  }

  async function fetchSummary(year) {
    return api(`/products/summary?year=${encodeURIComponent(year)}`);
  }

  async function fetchCatalog() {
    return api("/products/catalog");
  }

  return { fetchSummary, fetchCatalog };
})();
