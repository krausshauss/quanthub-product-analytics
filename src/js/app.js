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
    ["kpi-cw","kpi-pipe","kpi-products","kpi-top"].forEach(id => setEl(id, "—"));
    setEl("kpi-cw-sub", ""); setEl("kpi-pipe-sub", ""); setEl("kpi-top-sub", "");
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
    fill.style.background = cov.pct >= 80 ? "#22C55E" : cov.pct >= 50 ? "#F59E0B" : "#0077B5";
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
    if (el) el.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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
