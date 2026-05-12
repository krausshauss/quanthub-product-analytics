/**
 * cloudflare-worker.js — QuantHub Product Analytics
 * ─────────────────────────────────────────────────
 * Secrets (set via: npx wrangler secret put <NAME>):
 *   HUBSPOT_TOKEN   — pat-na1-... (same token as dashboard worker)
 *   ALLOWED_ORIGIN  — https://your-domain.com
 *
 * Routes:
 *   GET /products/summary   → aggregated revenue, pipeline, demand by product
 *   GET /products/catalog   → full HubSpot product library
 *   GET /products/reps      → per-rep × per-product breakdown
 *   GET /health             → sanity check
 */

const CORS = (origin) => ({
  "Access-Control-Allow-Origin":  origin || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

export default {
  async fetch(request, env) {
    const origin      = request.headers.get("Origin") || "";
    const corsHeaders = CORS(env.ALLOWED_ORIGIN || origin || "*");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {

      // ── GET /health ──────────────────────────────────────────────────
      if (path === "/health") {
        return json({ ok: true, worker: "quanthub-products", ts: Date.now() }, 200, corsHeaders);
      }

      // ── GET /products/catalog ─────────────────────────────────────────
      // Returns all products in the HubSpot product library.
      if (path === "/products/catalog" && request.method === "GET") {
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
        return json({ results: products }, 200, corsHeaders);
      }

      // ── GET /products/summary ─────────────────────────────────────────
      // Main analytics endpoint.
      // Returns per-product: cwRevenue, pipelineValue, dealCount, unitsSold,
      //   avgPrice, repBreakdown[], quarterlyRevenue{Q1,Q2,Q3,Q4}.
      if (path === "/products/summary" && request.method === "GET") {
        const year = url.searchParams.get("year") || "2026";
        const summary = await buildProductSummary(env, year);
        return json(summary, 200, corsHeaders);
      }

      // ── GET /products/reps ────────────────────────────────────────────
      // Per-rep breakdown: which products each rep sells, value, count.
      if (path === "/products/reps" && request.method === "GET") {
        const year = url.searchParams.get("year") || "2026";
        const summary = await buildProductSummary(env, year);
        return json({ reps: summary.repMatrix }, 200, corsHeaders);
      }

      return json({ error: "Not found" }, 404, corsHeaders);

    } catch (err) {
      console.error("[Worker] Error:", err.message);
      return json({ error: err.message }, 500, corsHeaders);
    }
  }
};

// Scope: only Higher Education pipeline, excluding specific owners.
const HE_PIPELINE_ID       = "753473109";
const EXCLUDED_OWNER_NAMES = ["Josh Jones", "Nate Spargo"];

// ── Core analytics builder ────────────────────────────────────────────────────
async function buildProductSummary(env, year) {
  const yearStart = `${year}-01-01T00:00:00.000Z`;

  // Resolve excluded owner IDs by name (one tiny API call per request).
  const excludedOwnerIds = await resolveOwnerIdsByName(env, EXCLUDED_OWNER_NAMES);

  const pipelineFilter = { propertyName: "pipeline", operator: "EQ", value: HE_PIPELINE_ID };

  // Step 1: Fetch all relevant deals in parallel
  //   a) Closed Won in the target year
  //   b) All open (pipeline) deals regardless of year
  const [cwRes, openRes] = await Promise.all([
    fetchDeals(env, [
      pipelineFilter,
      { propertyName: "hs_is_closed_won",   operator: "EQ",  value: "true" },
      { propertyName: "closedate",           operator: "GTE", value: yearStart },
    ]),
    fetchDeals(env, [
      pipelineFilter,
      { propertyName: "hs_is_closed",        operator: "EQ",  value: "false" },
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

  // Build a lookup map: dealId → deal properties
  const dealMap = {};
  allDeals.forEach(d => { dealMap[d.id] = d; });

  // Step 2: Get line item associations for all deals (batch, 100 at a time)
  const dealIds = allDeals.map(d => d.id);
  const lineItemIdsByDeal = await batchGetAssociations(env, "deals", "line_items", dealIds);

  // Coverage: how many deals have at least one line item attached
  const dealsWithProducts = Object.values(lineItemIdsByDeal).filter(ids => ids.length > 0).length;
  const coverage = {
    dealsWithProducts,
    totalDeals: allDeals.length,
    pct: allDeals.length > 0 ? Math.round((dealsWithProducts / allDeals.length) * 100) : 0,
  };

  // Collect unique line item IDs — if none yet, return empty product list
  // (expected when all deals are early-stage; not an error)
  const allLineItemIds = [...new Set(Object.values(lineItemIdsByDeal).flat())];

  if (!allLineItemIds.length) {
    return {
      products: [], repMatrix: [], totalCwRevenue: 0, totalPipeline: 0,
      totalProducts: 0, totalDeals: allDeals.length, coverage,
    };
  }

  // Step 3: Batch read all line items (100 at a time)
  const lineItems = await batchReadObjects(env, "line_items", allLineItemIds, [
    "name", "quantity", "price", "amount", "hs_product_id", "discount",
    "hs_recurring_billing_period", "description",
  ]);

  // Build a reverse map: lineItemId → dealId(s)
  const lineItemToDeal = {};
  Object.entries(lineItemIdsByDeal).forEach(([dealId, liIds]) => {
    liIds.forEach(liId => {
      if (!lineItemToDeal[liId]) lineItemToDeal[liId] = [];
      lineItemToDeal[liId].push(dealId);
    });
  });

  // Step 4: Aggregate by product name
  const productMap = {};   // productName → stats
  const repMatrix  = {};   // repName → { productName → { cwRevenue, pipelineValue, count } }

  lineItems.forEach(li => {
    const productName = li.properties.name || "Unknown Product";
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
        productMap[productName].cwRevenue     += amount;
        productMap[productName].unitsSold     += quantity;
        productMap[productName].dealCount     += 1;
        productMap[productName].prices.push(price);
        if (recurring) productMap[productName].isRecurring = true;

        // Quarterly breakdown
        if (closeDate) {
          const m = closeDate.getMonth();
          const q = m < 3 ? "Q1" : m < 6 ? "Q2" : m < 9 ? "Q3" : "Q4";
          productMap[productName].quarterlyRevenue[q] += amount;
        }

        // Rep matrix
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

      // Track unique deals
      if (!productMap[productName].deals.includes(dealId)) {
        productMap[productName].deals.push(dealId);
      }
    });
  });

  // Build final products array
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

  const totalCwRevenue  = products.reduce((s, p) => s + p.cwRevenue, 0);
  const totalPipeline   = products.reduce((s, p) => s + p.pipelineValue, 0);

  // Format rep matrix for output
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
    totalProducts:    products.length,
    totalDeals:       allDeals.length,
    coverage,
    generatedAt:      new Date().toISOString(),
  };
}

// ── HubSpot helpers ───────────────────────────────────────────────────────────

const REPS_BY_OWNER = {
  '81657454': 'Joe DeRario',
  '86826804': 'Jason Rupert',
  '90736265': 'Jakob Krause',
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

  // Process in chunks of 100
  for (let i = 0; i < ids.length; i += 100) {
    const chunk  = ids.slice(i, i + 100);
    const inputs = chunk.map(id => ({ id }));
    try {
      const data = await hsPost(
        env,
        `/crm/v4/associations/${fromType}/${toType}/batch/read`,
        { inputs }
      );
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
      const data = await hsPost(env, `/crm/v3/objects/${objectType}/batch/read`, {
        properties,
        inputs,
      });
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
    headers: {
      "Authorization": `Bearer ${env.HUBSPOT_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
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

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}
