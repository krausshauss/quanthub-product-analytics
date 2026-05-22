/**
 * repMatrix.js
 * Per-rep × per-product revenue breakdown — stacked row cards.
 */
window.RepMatrix = (() => {

  const REP_COLORS = {
    "Joe DeRario":   "#0077B5",
    "Jason Rupert":  "#22C55E",
    "Jakob Krause":  "#F59E0B",
  };

  function colorFor(rep) {
    return REP_COLORS[rep] || "#7A8FA6";
  }

  function render(repMatrix) {
    const el = document.getElementById("rep-matrix");
    if (!el) return;

    // Only render known reps — drops "Other" / unmapped owners.
    repMatrix = (repMatrix || []).filter(r => r.rep in REP_COLORS);

    if (!repMatrix.length) {
      el.innerHTML = `<div class="rm-empty">No rep data available.</div>`;
      return;
    }

    // Find all unique product names across all reps
    const allProducts = [...new Set(
      repMatrix.flatMap(r => r.products.map(p => p.name))
    )];

    el.innerHTML = repMatrix.map((rep, ri) => {
      const color   = colorFor(rep.rep);
      const initials = rep.rep.split(" ").map(w => w[0]).join("").slice(0, 2);
      const totalCW  = rep.products.reduce((s, p) => s + p.cwRevenue, 0);
      const totalPipe= rep.products.reduce((s, p) => s + p.pipelineValue, 0);

      const topProducts = rep.products.slice(0, 5);

      return `
        <div class="rm-card fade-up" style="animation-delay:${ri * 60}ms">
          <div class="rm-header">
            <div class="rm-avatar" style="background:${color}20;color:${color};border-color:${color}40">${initials}</div>
            <div class="rm-rep-info">
              <div class="rm-rep-name">${escHtml(rep.rep)}</div>
              <div class="rm-rep-totals">
                CW <strong>${window.CONFIG.fmtMoney(totalCW)}</strong>
                · Pipeline <strong>${window.CONFIG.fmtMoney(totalPipe)}</strong>
              </div>
            </div>
          </div>
          <div class="rm-products">
            ${topProducts.map(p => {
              const maxVal = Math.max(totalCW, 1);
              const barPct = Math.round((p.cwRevenue / maxVal) * 100);
              return `
                <div class="rm-product-row">
                  <span class="rm-product-name" title="${escHtml(p.name)}">${escHtml(truncate(p.name, 28))}</span>
                  <div class="rm-prod-bar-bg">
                    <div class="rm-prod-bar-fill" style="width:${barPct}%;background:${color}"></div>
                  </div>
                  <span class="rm-product-val">${window.CONFIG.fmtMoney(p.cwRevenue || p.pipelineValue)}</span>
                  <span class="rm-product-count">${p.count || 0} deal${(p.count || 0) !== 1 ? "s" : ""}</span>
                </div>`;
            }).join("")}
            ${rep.products.length > 5 ? `<div class="rm-more">+${rep.products.length - 5} more products</div>` : ''}
          </div>
        </div>`;
    }).join("");
  }

  function renderLoading() {
    const el = document.getElementById("rep-matrix");
    if (!el) return;
    el.innerHTML = [1, 2, 3].map(i => `
      <div class="rm-card">
        <div class="rm-header">
          <div class="skeleton-block" style="width:36px;height:36px;border-radius:50%;margin:0;flex-shrink:0"></div>
          <div style="flex:1"><div class="skeleton-block" style="height:13px;width:60%;margin:0 0 6px"></div><div class="skeleton-block" style="height:11px;width:40%;margin:0"></div></div>
        </div>
        <div class="rm-products">${[1,2,3].map(() => `<div class="skeleton-block" style="height:14px;margin:4px 0 0"></div>`).join("")}</div>
      </div>`).join("");
  }

  function renderError(msg) {
    const el = document.getElementById("rep-matrix");
    if (el) el.innerHTML = `<div class="rm-empty">⚠ ${escHtml(msg)}</div>`;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  return { render, renderLoading, renderError };
})();
