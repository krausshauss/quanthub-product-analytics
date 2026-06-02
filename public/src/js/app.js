/**
 * app.js — Product Analytics orchestrator
 */
window.App = (() => {

  let _data = null;
  let _year = window.CONFIG.YEAR;

  async function init() {
    updateLive("connecting");
    setupYearSelector();
    await refresh();
  }

  async function refresh() {
    showLoading();
    updateLive("connecting");
    try {
      _data = await window.HubSpot.fetchSummary(_year);
      renderAll(_data);
      updateLive("live");
      setRefresh();
    } catch (err) {
      console.error("[App]", err);
      updateLive("error");
      window.ProductTable.renderError(err.message);
      window.PipelineBar.renderError(err.message);
      window.RepMatrix.renderError(err.message);
    }
  }

  function renderAll(data) {
    updateKPIs(data);
    updateCoverage(data.coverage);
    window.ProductTable.render(data.products || []);
    window.PipelineBar.render(data.products || []);
    window.RepMatrix.render(data.repMatrix || []);
  }

  function showLoading() {
    window.ProductTable.renderLoading();
    window.PipelineBar.renderLoading();
    window.RepMatrix.renderLoading();
    ["kpi-cw","kpi-pipe","kpi-products","kpi-top",
     "gauge-quota-val","gauge-recurring-val","gauge-coverage-val","velocity-pct"]
      .forEach(id => setEl(id, "—"));
    ["kpi-cw-sub","kpi-pipe-sub","kpi-top-sub",
     "gauge-quota-sub","gauge-recurring-sub","gauge-coverage-sub","velocity-sub"]
      .forEach(id => setEl(id, ""));
    resetGauge("gauge-quota-arc");
    resetGauge("gauge-recurring-arc");
    resetGauge("gauge-coverage-arc");
  }

  function updateKPIs(data) {
    const fmt = window.CONFIG.fmtMoney;
    setEl("kpi-cw",       fmt(data.totalCwRevenue));
    setEl("kpi-cw-sub",   `across ${data.totalProducts} product${data.totalProducts !== 1 ? "s" : ""}`);
    setEl("kpi-pipe",     fmt(data.totalPipeline));
    setEl("kpi-pipe-sub", `${data.totalDeals} total deals tracked`);
    setEl("kpi-products", data.totalProducts);
    setEl("kpi-products-sub", `with quotes in ${_year}`);

    const top = data.products?.[0];
    if (top) {
      setEl("kpi-top",     truncate(top.name, 22));
      setEl("kpi-top-sub", `${fmt(top.cwRevenue)} CW · ${fmt(top.pipelineValue)} pipeline`);
    }

    updateGauges(data);
  }

  // ── Gauge widgets ──────────────────────────────────────────────────
  const ARC_LEN = 125.66;  // π × r where r = 40

  function setArc(id, pct /* 0..1, clamped visually */) {
    const el = document.getElementById(id);
    if (!el) return;
    const clamped = Math.max(0, Math.min(1, pct));
    el.style.strokeDashoffset = ARC_LEN * (1 - clamped);
  }

  function resetGauge(id) {
    const el = document.getElementById(id);
    if (el) el.style.strokeDashoffset = ARC_LEN;
  }

  function setCardState(cardEl, state) {
    if (!cardEl) return;
    cardEl.classList.remove("gauge-good","gauge-warn","gauge-bad",
                            "velocity-up","velocity-down","velocity-flat");
    if (state) cardEl.classList.add(state);
  }

  function updateGauges(data) {
    const fmt   = window.CONFIG.fmtMoney;
    const quota = window.CONFIG.ANNUAL_QUOTA || 0;
    const cw    = data.totalCwRevenue || 0;
    const pipe  = data.totalPipeline  || 0;

    // 1) Quota Attainment
    const quotaCard = document.getElementById("gauge-quota-arc")?.closest(".kpi-card");
    if (quota > 0) {
      const ratio = cw / quota;
      setArc("gauge-quota-arc", ratio);
      setEl("gauge-quota-val", `${Math.round(ratio * 100)}%`);
      setEl("gauge-quota-sub", `${fmt(cw)} of ${fmt(quota)}`);
      setCardState(quotaCard,
        ratio >= 0.95 ? "gauge-good" :
        ratio >= 0.70 ? "gauge-warn" : "gauge-bad");
    }

    // 2) QoQ Velocity (sum products' quarterlyRevenue across the catalog)
    const qTot = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    (data.products || []).forEach(p => {
      const qr = p.quarterlyRevenue || {};
      qTot.Q1 += qr.Q1 || 0; qTot.Q2 += qr.Q2 || 0;
      qTot.Q3 += qr.Q3 || 0; qTot.Q4 += qr.Q4 || 0;
    });
    const m = new Date().getMonth();
    const curQ = m < 3 ? "Q1" : m < 6 ? "Q2" : m < 9 ? "Q3" : "Q4";
    const prevQ = { Q1: "Q4", Q2: "Q1", Q3: "Q2", Q4: "Q3" }[curQ];
    const curVal  = qTot[curQ];
    const prevVal = qTot[prevQ];
    const velCard = document.getElementById("velocity-wrap");
    if (prevVal > 0) {
      const delta = (curVal - prevVal) / prevVal;
      const pct   = Math.round(delta * 100);
      setEl("velocity-pct",   `${pct >= 0 ? "+" : ""}${pct}%`);
      setEl("velocity-arrow", pct > 2 ? "▲" : pct < -2 ? "▼" : "▬");
      setEl("velocity-sub",   `${curQ} vs ${prevQ}`);
      setCardState(velCard, pct > 2 ? "velocity-up" : pct < -2 ? "velocity-down" : "velocity-flat");
    } else if (curVal > 0) {
      setEl("velocity-pct",   "new");
      setEl("velocity-arrow", "▲");
      setEl("velocity-sub",   `${curQ} · no ${prevQ} baseline`);
      setCardState(velCard, "velocity-up");
    } else {
      setEl("velocity-pct",   "—");
      setEl("velocity-arrow", "–");
      setEl("velocity-sub",   `${curQ} pending`);
      setCardState(velCard, "velocity-flat");
    }

    // 3) Recurring Mix
    const recurCw = (data.products || [])
      .filter(p => p.isRecurring)
      .reduce((s, p) => s + (p.cwRevenue || 0), 0);
    const recurCard = document.getElementById("gauge-recurring-arc")?.closest(".kpi-card");
    if (cw > 0) {
      const ratio = recurCw / cw;
      setArc("gauge-recurring-arc", ratio);
      setEl("gauge-recurring-val", `${Math.round(ratio * 100)}%`);
      setEl("gauge-recurring-sub", `${fmt(recurCw)} of ${fmt(cw)}`);
      setCardState(recurCard, null);
    } else {
      setEl("gauge-recurring-val", "—");
      setEl("gauge-recurring-sub", "no closed-won yet");
    }

    // 4) Pipeline Coverage (× of remaining quota gap)
    const gap = Math.max(0, quota - cw);
    const covCard = document.getElementById("gauge-coverage-arc")?.closest(".kpi-card");
    if (gap === 0 && quota > 0) {
      setArc("gauge-coverage-arc", 1);
      setEl("gauge-coverage-val", "✓");
      setEl("gauge-coverage-sub", "quota covered");
      setCardState(covCard, "gauge-good");
    } else if (gap > 0) {
      const mult = pipe / gap;
      // Visualize on a 0–3× scale (3× and above = full arc, considered healthy)
      setArc("gauge-coverage-arc", mult / 3);
      setEl("gauge-coverage-val", `${mult.toFixed(1)}×`);
      setEl("gauge-coverage-sub", `${fmt(pipe)} vs ${fmt(gap)} gap`);
      setCardState(covCard,
        mult >= 3   ? "gauge-good" :
        mult >= 1.5 ? "gauge-warn" : "gauge-bad");
    }
  }

  function updateCoverage(cov) {
    if (!cov) return;
    const bar  = document.getElementById("coverage-bar");
    const text = document.getElementById("coverage-text");
    const fill = document.getElementById("coverage-fill");
    const pct  = document.getElementById("coverage-pct");
    if (!bar) return;

    bar.style.display = "flex";
    const without = cov.totalDeals - cov.dealsWithProducts;
    text.textContent = `Quote coverage: ${cov.dealsWithProducts} of ${cov.totalDeals} deals have products attached`;
    if (without > 0) text.textContent += ` · ${without} early-stage deal${without !== 1 ? "s" : ""} not yet quoted`;
    fill.style.width  = `${cov.pct}%`;
    fill.style.background = cov.pct >= 80 ? "#22C55E" : cov.pct >= 50 ? "#F59E0B" : "#2563EB";
    pct.textContent   = `${cov.pct}%`;
  }

  function setupYearSelector() {
    const sel = document.getElementById("year-select");
    if (!sel) return;
    const cur = new Date().getFullYear();
    [cur, cur - 1].forEach(y => {
      const o = document.createElement("option");
      o.value = y; o.textContent = y;
      if (String(y) === _year) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", () => {
      _year = sel.value;
      setEl("header-year", _year);
      refresh();
    });
    sel.style.display = "block";
  }

  function updateLive(state) {
    const el = document.getElementById("live-badge");
    if (!el) return;
    const MAP = {
      connecting: { text: "● CONNECTING", cls: "badge badge-connecting" },
      live:       { text: "● LIVE",        cls: "badge badge-live" },
      error:      { text: "● ERROR",       cls: "badge badge-error" },
    };
    const s = MAP[state] || MAP.live;
    el.textContent = s.text;
    el.className   = s.cls;
  }

  function setRefresh() {
    const el = document.getElementById("last-refresh");
    if (!el) return;
    const now  = new Date();
    const date = now.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.textContent = `Last sync: ${date} · ${time}`;
  }

  function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  document.addEventListener("DOMContentLoaded", init);

  return { refresh };
})();
