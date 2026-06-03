/**
 * cloudflare-worker.js — Dark Yeti Product Analytics
 * ─────────────────────────────────────────────────
 * Secrets (set via: npx wrangler secret put <NAME>):
 *   HUBSPOT_TOKEN     — pat-na1-... (HubSpot Private App token)
 *   PORTAL_PASSWORD   — password used to log into the portal
 *   SESSION_SECRET    — long random string for HMAC-signing session cookies
 *
 * Routes:
 *   GET  /login              → login page (always public)
 *   POST /auth               → submit password, set session cookie, redirect to /
 *   GET  /logout             → clear cookie, redirect to /login
 *   GET  /                   → app HTML (auth required, served from /public)
 *   GET  /src/*              → app assets (auth required, served from /public)
 *   GET  /health             → sanity check (auth required)
 *   GET  /products/summary   → aggregated revenue, pipeline, demand by product
 *   GET  /products/catalog   → full HubSpot product library
 *   GET  /products/reps      → per-rep × per-product breakdown
 */

// Gated entry page, bundled into the worker at build time (see wrangler.toml
// [[rules]] Text). Served only after auth; never exposed as a public asset.
import INDEX_HTML from "./index.html";

const SESSION_COOKIE     = "qh_session";
const SESSION_DURATION_S = 30 * 24 * 60 * 60;       // 30 days
const MAX_FAILS          = 5;
const FAIL_WINDOW_MS     = 15 * 60 * 1000;          // 15 minutes

// In-memory rate-limit map. Per-isolate, so not perfectly enforced across
// the Cloudflare edge, but adequate for a low-traffic internal portal.
const failedAttempts = new Map();

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    try {
      // ── Always-public auth routes ─────────────────────────────────
      if (path === "/login" && method === "GET") {
        return loginPage();
      }
      if (path === "/auth" && method === "POST") {
        return handleAuth(request, env);
      }
      if (path === "/logout") {
        return logout();
      }

      // ── Everything else requires a valid session ──────────────────
      const authed = await isAuthed(request, env);

      if (!authed) {
        // HTML navigations get redirected; API calls get a clean 401.
        const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
        if (method === "GET" && wantsHtml) {
          return Response.redirect(new URL("/login", url), 302);
        }
        return json({ error: "Unauthorized" }, 401);
      }

      // ── Authed: entry page (bundled, gated) ───────────────────────
      // /src/* static files are served directly by the [assets] binding and
      // never reach the worker — they hold no secrets.
      if (method === "GET" && (path === "/" || path === "")) {
        return html(INDEX_HTML);
      }

      // ── Authed: data API (existing routes) ────────────────────────
      if (path === "/health") {
        return json({ ok: true, worker: "dark-yeti-products", ts: Date.now() });
      }

      if (path === "/products/catalog" && method === "GET") {
        const raw = await hsPost(env, "/crm/v3/objects/products/search", {
          properties: ["name", "price", "description", "hs_sku", "hs_product_type", "hs_folder_name"],
          sorts: [{ propertyName: "name", direction: "ASCENDING" }],
          limit: 200,
        });
        const products = (raw.results || []).map(p => ({
          id:          p.id,
          name:        p.properties.name || "Unnamed",
          price:       parseFloat(p.properties.price) || 0,
          sku:         p.properties.hs_sku || "",
          type:        p.properties.hs_product_type || "",
          folder:      p.properties.hs_folder_name || "",
          description: p.properties.description || "",
        }));
        return json({ results: products });
      }

      if (path === "/products/summary" && method === "GET") {
        const year = url.searchParams.get("year") || "2026";
        const summary = await buildProductSummary(env, year);
        return json(summary);
      }

      if (path === "/products/reps" && method === "GET") {
        const year = url.searchParams.get("year") || "2026";
        const summary = await buildProductSummary(env, year);
        return json({ reps: summary.repMatrix });
      }

      return json({ error: "Not found" }, 404);

    } catch (err) {
      console.error("[Worker] Error:", err.message);
      return json({ error: err.message }, 500);
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════
//   Auth
// ═══════════════════════════════════════════════════════════════════════════

async function isAuthed(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !env.SESSION_SECRET) return false;
  return verifySession(token, env.SESSION_SECRET);
}

async function handleAuth(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  if (!checkRateLimit(ip)) {
    return loginPage("Too many failed attempts. Wait 15 minutes and try again.", 429);
  }

  if (!env.PORTAL_PASSWORD || !env.SESSION_SECRET) {
    return loginPage("Server misconfigured: missing secret(s).", 500);
  }

  const form     = await request.formData();
  const password = (form.get("password") || "").toString();

  if (!timingSafeEqualStr(password, env.PORTAL_PASSWORD)) {
    recordFailure(ip);
    return loginPage("Incorrect password.", 401);
  }

  clearFailures(ip);
  const token = await makeSession(env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      "Location":   "/",
      "Set-Cookie": cookieHeader(token, SESSION_DURATION_S),
    },
  });
}

function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      "Location":   "/login",
      "Set-Cookie": cookieHeader("", 0),
    },
  });
}

function cookieHeader(value, maxAgeS) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeS}`;
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const m   = raw.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

// ── HMAC-signed session token ────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64uEncode(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const norm = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64uEncode(sig);
}

async function makeSession(secret) {
  const now     = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ iat: now, exp: now + SESSION_DURATION_S });
  const pb64    = b64uEncode(enc.encode(payload));
  const sig     = await hmacSign(secret, pb64);
  return `${pb64}.${sig}`;
}

async function verifySession(token, secret) {
  if (!token || !token.includes(".")) return false;
  const [pb64, sig] = token.split(".");
  if (!pb64 || !sig) return false;
  const expectedSig = await hmacSign(secret, pb64);
  if (!timingSafeEqualStr(sig, expectedSig)) return false;
  try {
    const payload = JSON.parse(dec.decode(b64uDecode(pb64)));
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

// ── Rate limiting (per-isolate) ──────────────────────────────────────────────

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry) return true;
  if (now - entry.firstAt > FAIL_WINDOW_MS) {
    failedAttempts.delete(ip);
    return true;
  }
  return entry.count < MAX_FAILS;
}

function recordFailure(ip) {
  const now   = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now - entry.firstAt > FAIL_WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count++;
  }
}

function clearFailures(ip) {
  failedAttempts.delete(ip);
}

// ═══════════════════════════════════════════════════════════════════════════
//   Login page
// ═══════════════════════════════════════════════════════════════════════════

function loginPage(errMsg = "", status = 200) {
  const safe = errMsg.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dark Yeti · Sign in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    *,*::before,*::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body { font-family: 'Manrope', -apple-system, sans-serif; background: #0a0e1a; color: #e6edf3; display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .card { background: #161b22; padding: 2.5rem 2rem; border-radius: 14px; width: 100%; max-width: 360px; box-shadow: 0 12px 40px rgba(0,0,0,0.6); border: 1px solid #30363d; }
    .brand { color: #2563EB; font-weight: 800; letter-spacing: 0.05em; font-size: 0.85rem; text-transform: uppercase; }
    h1 { margin: 0.25rem 0 1.5rem; font-size: 1.4rem; font-weight: 700; }
    label { display: block; font-size: 0.8rem; color: #8b949e; margin-bottom: 0.4rem; }
    input { width: 100%; padding: 0.75rem 0.9rem; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #e6edf3; font-family: inherit; font-size: 0.95rem; }
    input:focus { outline: none; border-color: #2563EB; box-shadow: 0 0 0 3px rgba(37,99,235, 0.2); }
    button { width: 100%; margin-top: 1.1rem; padding: 0.8rem; background: #2563EB; color: white; border: none; border-radius: 8px; font-family: inherit; font-size: 0.95rem; font-weight: 700; cursor: pointer; transition: background 0.15s; }
    button:hover { background: #005c8a; }
    .err { color: #f85149; font-size: 0.85rem; margin-top: 0.9rem; min-height: 1.2em; text-align: center; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">Dark Yeti</div>
    <h1>Sign in</h1>
    <form method="POST" action="/auth">
      <label for="pw">Password</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required />
      <button type="submit">Continue</button>
      <div class="err">${safe}</div>
    </form>
  </main>
</body>
</html>`;
  return html(body, status);
}

// ═══════════════════════════════════════════════════════════════════════════
//   Response helpers
// ═══════════════════════════════════════════════════════════════════════════

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":  "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type":           "text/html; charset=utf-8",
      "Cache-Control":          "no-store",
      "X-Frame-Options":        "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy":        "no-referrer",
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//   Product analytics — unchanged business logic below
// ═══════════════════════════════════════════════════════════════════════════

// Scope: only Higher Education pipeline, excluding specific owners.
const HE_PIPELINE_ID       = "753473109";
const EXCLUDED_OWNER_NAMES = ["Josh Jones", "Nate Spargo"];

async function buildProductSummary(env, year) {
  const yearStart = `${year}-01-01T00:00:00.000Z`;

  const excludedOwnerIds = await resolveOwnerIdsByName(env, EXCLUDED_OWNER_NAMES);
  const pipelineFilter   = { propertyName: "pipeline", operator: "EQ", value: HE_PIPELINE_ID };

  const [cwRes, openRes] = await Promise.all([
    fetchDeals(env, [
      pipelineFilter,
      { propertyName: "hs_is_closed_won", operator: "EQ",  value: "true" },
      { propertyName: "closedate",        operator: "GTE", value: yearStart },
    ]),
    fetchDeals(env, [
      pipelineFilter,
      { propertyName: "hs_is_closed", operator: "EQ", value: "false" },
    ]),
  ]);

  const allDeals = [...cwRes, ...openRes].filter(d =>
    !excludedOwnerIds.has(String(d.properties.hubspot_owner_id || ""))
  );

  if (!allDeals.length) {
    return {
      products: [], repMatrix: [], totalCwRevenue: 0, totalPipeline: 0,
      totalProducts: 0, totalDeals: 0,
      coverage: { dealsWithProducts: 0, totalDeals: 0, pct: 0 },
    };
  }

  const dealMap = {};
  allDeals.forEach(d => { dealMap[d.id] = d; });

  const dealIds            = allDeals.map(d => d.id);
  const lineItemIdsByDeal  = await batchGetAssociations(env, "deals", "line_items", dealIds);

  const dealsWithProducts = Object.values(lineItemIdsByDeal).filter(ids => ids.length > 0).length;
  const coverage = {
    dealsWithProducts,
    totalDeals: allDeals.length,
    pct: allDeals.length > 0 ? Math.round((dealsWithProducts / allDeals.length) * 100) : 0,
  };

  const allLineItemIds = [...new Set(Object.values(lineItemIdsByDeal).flat())];
  if (!allLineItemIds.length) {
    return {
      products: [], repMatrix: [], totalCwRevenue: 0, totalPipeline: 0,
      totalProducts: 0, totalDeals: allDeals.length, coverage,
    };
  }

  const lineItems = await batchReadObjects(env, "line_items", allLineItemIds, [
    "name", "quantity", "price", "amount", "hs_product_id", "discount",
    "hs_recurring_billing_period", "description",
  ]);

  const libraryProductIds = [...new Set(
    lineItems.map(li => li.properties.hs_product_id).filter(id => id)
  )];
  const libraryNames = {};
  if (libraryProductIds.length) {
    const products = await batchReadObjects(env, "products", libraryProductIds, ["name"]);
    products.forEach(p => {
      if (p.properties?.name) libraryNames[p.id] = p.properties.name;
    });
  }

  const lineItemToDeal = {};
  Object.entries(lineItemIdsByDeal).forEach(([dealId, liIds]) => {
    liIds.forEach(liId => {
      if (!lineItemToDeal[liId]) lineItemToDeal[liId] = [];
      lineItemToDeal[liId].push(dealId);
    });
  });

  const productMap = {};
  const repMatrix  = {};

  lineItems.forEach(li => {
    const libId       = li.properties.hs_product_id;
    const productName = (libId && libraryNames[libId])
      || li.properties.name
      || "Unknown Product";
    const amount      = parseFloat(li.properties.amount) || 0;
    const quantity    = parseFloat(li.properties.quantity) || 1;
    const price       = parseFloat(li.properties.price) || 0;
    const recurring   = li.properties.hs_recurring_billing_period || null;

    if (!productMap[productName]) {
      productMap[productName] = {
        name:            productName,
        cwRevenue:       0,
        pipelineValue:   0,
        dealCount:       0,
        unitsSold:       0,
        unitsPipeline:   0,
        prices:          [],
        deals:           [],
        isRecurring:     false,
        quarterlyRevenue: { Q1: 0, Q2: 0, Q3: 0, Q4: 0 },
      };
    }

    const dealIds = lineItemToDeal[li.id] || [];
    dealIds.forEach(dealId => {
      const deal = dealMap[dealId];
      if (!deal) return;

      const isCW      = deal.properties.hs_is_closed_won === "true";
      const isClosed  = deal.properties.hs_is_closed     === "true";
      const isOpen    = !isClosed;
      const closeDate = deal.properties.closedate ? new Date(deal.properties.closedate) : null;
      const repName   = deal.repName || "Unknown";

      if (isCW) {
        productMap[productName].cwRevenue += amount;
        productMap[productName].unitsSold += quantity;
        productMap[productName].dealCount += 1;
        productMap[productName].prices.push(price);
        if (recurring) productMap[productName].isRecurring = true;

        if (closeDate) {
          const m = closeDate.getMonth();
          const q = m < 3 ? "Q1" : m < 6 ? "Q2" : m < 9 ? "Q3" : "Q4";
          productMap[productName].quarterlyRevenue[q] += amount;
        }

        if (!repMatrix[repName]) repMatrix[repName] = {};
        if (!repMatrix[repName][productName]) {
          repMatrix[repName][productName] = { cwRevenue: 0, pipelineValue: 0, count: 0 };
        }
        repMatrix[repName][productName].cwRevenue += amount;
        repMatrix[repName][productName].count     += 1;

      } else if (isOpen) {
        productMap[productName].pipelineValue += amount;
        productMap[productName].unitsPipeline += quantity;

        if (!repMatrix[repName]) repMatrix[repName] = {};
        if (!repMatrix[repName][productName]) {
          repMatrix[repName][productName] = { cwRevenue: 0, pipelineValue: 0, count: 0 };
        }
        repMatrix[repName][productName].pipelineValue += amount;
        repMatrix[repName][productName].count         += 1;
      }

      if (!productMap[productName].deals.includes(dealId)) {
        productMap[productName].deals.push(dealId);
      }
    });
  });

  const products = Object.values(productMap).map(p => ({
    name:            p.name,
    cwRevenue:       Math.round(p.cwRevenue),
    pipelineValue:   Math.round(p.pipelineValue),
    dealCount:       p.dealCount,
    totalDeals:      p.deals.length,
    unitsSold:       p.unitsSold,
    unitsPipeline:   p.unitsPipeline,
    avgPrice:        p.prices.length ? Math.round(p.prices.reduce((a, b) => a + b, 0) / p.prices.length) : 0,
    isRecurring:     p.isRecurring,
    quarterlyRevenue: p.quarterlyRevenue,
  })).sort((a, b) => (b.cwRevenue + b.pipelineValue) - (a.cwRevenue + a.pipelineValue));

  const totalCwRevenue = products.reduce((s, p) => s + p.cwRevenue,     0);
  const totalPipeline  = products.reduce((s, p) => s + p.pipelineValue, 0);

  const repMatrixOut = Object.entries(repMatrix).map(([rep, prods]) => ({
    rep,
    products: Object.entries(prods)
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => (b.cwRevenue + b.pipelineValue) - (a.cwRevenue + a.pipelineValue)),
  })).sort((a, b) => {
    const aRev = a.products.reduce((s, p) => s + p.cwRevenue, 0);
    const bRev = b.products.reduce((s, p) => s + p.cwRevenue, 0);
    return bRev - aRev;
  });

  return {
    year,
    products,
    repMatrix: repMatrixOut,
    totalCwRevenue,
    totalPipeline,
    totalProducts: products.length,
    totalDeals:    allDeals.length,
    coverage,
    generatedAt:   new Date().toISOString(),
  };
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────

const REPS_BY_OWNER = {
  "81657454": "Joe DeRario",
  "86826804": "Jason Rupert",
  "90736265": "Jakob Krause",
};

async function fetchDeals(env, filters) {
  const results = [];
  let after = undefined;
  do {
    const body = {
      properties: [
        "dealname", "amount", "closedate", "dealstage", "pipeline",
        "hubspot_owner_id", "hs_is_closed_won", "hs_is_closed",
      ],
      filterGroups: [{ filters }],
      sorts: [{ propertyName: "closedate", direction: "DESCENDING" }],
      limit: 200,
    };
    if (after) body.after = after;

    const data = await hsPost(env, "/crm/v3/objects/deals/search", body);
    const page = data.results || [];
    page.forEach(d => {
      d.repName = REPS_BY_OWNER[d.properties.hubspot_owner_id] || "Other";
    });
    results.push(...page);
    after = data.paging?.next?.after;
  } while (after && results.length < 1000);
  return results;
}

async function batchGetAssociations(env, fromType, toType, ids) {
  const result = {};
  ids.forEach(id => { result[id] = []; });
  for (let i = 0; i < ids.length; i += 100) {
    const chunk  = ids.slice(i, i + 100);
    const inputs = chunk.map(id => ({ id }));
    try {
      const data = await hsPost(env, `/crm/v4/associations/${fromType}/${toType}/batch/read`, { inputs });
      (data.results || []).forEach(r => {
        const fromId = r.from?.id;
        if (fromId && r.to?.length) {
          result[fromId] = r.to.map(t => String(t.toObjectId));
        }
      });
    } catch (e) {
      console.warn(`[Worker] Association batch failed: ${e.message}`);
    }
  }
  return result;
}

async function batchReadObjects(env, objectType, ids, properties) {
  const results = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk  = ids.slice(i, i + 100);
    const inputs = chunk.map(id => ({ id }));
    try {
      const data = await hsPost(env, `/crm/v3/objects/${objectType}/batch/read`, { properties, inputs });
      results.push(...(data.results || []));
    } catch (e) {
      console.warn(`[Worker] Batch read ${objectType} failed: ${e.message}`);
    }
  }
  return results;
}

async function hsPost(env, endpoint, body) {
  const res = await fetch(`https://api.hubapi.com${endpoint}`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${env.HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`HubSpot ${endpoint}: ${res.status} — ${txt}`);
  }
  return res.json();
}

async function hsGet(env, endpoint) {
  const res = await fetch(`https://api.hubapi.com${endpoint}`, {
    method:  "GET",
    headers: { "Authorization": `Bearer ${env.HUBSPOT_TOKEN}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`HubSpot ${endpoint}: ${res.status} — ${txt}`);
  }
  return res.json();
}

async function resolveOwnerIdsByName(env, names) {
  const wanted = new Set(names.map(n => n.toLowerCase().trim()));
  const ids    = new Set();
  let after = undefined;
  do {
    const qs   = after ? `?limit=100&after=${encodeURIComponent(after)}` : `?limit=100`;
    const page = await hsGet(env, `/crm/v3/owners${qs}`);
    (page.results || []).forEach(o => {
      const full = `${o.firstName || ""} ${o.lastName || ""}`.toLowerCase().trim();
      if (wanted.has(full)) ids.add(String(o.id));
    });
    after = page.paging?.next?.after;
  } while (after && ids.size < wanted.size);
  if (ids.size < wanted.size) {
    console.warn(`[Worker] Owner lookup: matched ${ids.size}/${wanted.size} of ${[...wanted].join(", ")}`);
  }
  return ids;
}
