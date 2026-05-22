/**
 * pipelineBar.js
 * Dual horizontal bar: CW Revenue (solid) + Pipeline (striped), per product.
 */
window.PipelineBar = (() => {

  function render(products) {
    const el = document.getElementById("pipeline-bars");
    if (!el) return;

    const top = [...(products || [])]
      .filter(p => p.cwRevenue > 0 || p.pipelineValue > 0)
      .sort((a, b) => (b.cwRevenue + b.pipelineValue) - (a.cwRevenue + a.pipelineValue))
      .slice(0, 8);

    if (!top.length) {
      el.innerHTML = `<div class="pb-empty">No pipeline or revenue data yet.</div>`;
      return;
    }

    const maxVal = Math.max(...top.map(p => p.cwRevenue + p.pipelineValue), 1);

    el.innerHTML = top.map((p, i) => {
      const cwPct   = Math.round((p.cwRevenue    / maxVal) * 100);
      const pipePct = Math.round((p.pipelineValue / maxVal) * 100);
      const totalPct = Math.min(cwPct + pipePct, 100);
      return `
        <div class="pb-row fade-up" style="animation-delay:${i * 40}ms">
          <div class="pb-label" title="${escHtml(p.name)}">${escHtml(truncate(p.name, 26))}</div>
          <div class="pb-track">
            <div class="pb-fill-cw"    style="width:${cwPct}%"   title="CW: ${window.CONFIG.fmtMoney(p.cwRevenue)}"></div>
            <div class="pb-fill-pipe"  style="width:${pipePct}%" title="Pipeline: ${window.CONFIG.fmtMoney(p.pipelineValue)}"></div>
          </div>
          <div class="pb-vals">
            ${p.cwRevenue    > 0 ? `<span class="pb-cw">${window.CONFIG.fmtMoney(p.cwRevenue)}</span>`    : ''}
            ${p.pipelineValue > 0 ? `<span class="pb-pipe">${window.CONFIG.fmtMoney(p.pipelineValue)}</span>` : ''}
          </div>
        </div>`;
    }).join("");
  }

  function renderLoading() {
    const el = document.getElementById("pipeline-bars");
    if (!el) return;
    el.innerHTML = [1,2,3,4].map(i =>
      `<div class="pb-row"><div class="pb-label"><div class="skeleton-block" style="height:12px;width:80%;margin:0"></div></div><div class="pb-track"><div class="skeleton-block" style="height:10px;margin:0;border-radius:4px"></div></div></div>`
    ).join("");
  }

  function renderError(msg) {
    const el = document.getElementById("pipeline-bars");
    if (el) el.innerHTML = `<div class="pb-empty">⚠ ${escHtml(msg)}</div>`;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  return { render, renderLoading, renderError };
})();
