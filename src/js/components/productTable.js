/**
 * productTable.js
 * Main product performance table — sortable columns.
 */
window.ProductTable = (() => {

  let _products = [];
  let _sortKey  = "cwRevenue";
  let _sortAsc  = false;

  const COLS = [
    { key: "name",          label: "Product",          fmt: v => escHtml(v),                          cls: "pt-name" },
    { key: "totalDeals",    label: "Deals",             fmt: v => v,                                   cls: "pt-num"  },
    { key: "unitsSold",     label: "Units Sold",        fmt: v => v,                                   cls: "pt-num"  },
    { key: "avgPrice",      label: "Avg Price",         fmt: v => window.CONFIG.fmtMoney(v),           cls: "pt-num"  },
    { key: "cwRevenue",     label: "CW Revenue",        fmt: v => window.CONFIG.fmtMoney(v),           cls: "pt-num pt-highlight" },
    { key: "pipelineValue", label: "Pipeline",          fmt: v => window.CONFIG.fmtMoney(v),           cls: "pt-num pt-pipe"      },
    { key: "winRate",       label: "Win Rate",          fmt: v => v != null ? `${v}%` : "—",          cls: "pt-num"  },
  ];

  function render(products) {
    _products = products || [];
    _draw();
  }

  function _draw() {
    const el = document.getElementById("product-table-body");
    if (!el) return;

    const sorted = [..._products]
      .map(p => ({
        ...p,
        winRate: p.totalDeals > 0 ? Math.round((p.dealCount / p.totalDeals) * 100) : null,
      }))
      .sort((a, b) => {
        const av = a[_sortKey] ?? -1;
        const bv = b[_sortKey] ?? -1;
        return _sortAsc ? av - bv : bv - av;
      });

    if (!sorted.length) {
      el.innerHTML = `<tr><td colspan="${COLS.length}" class="pt-empty">No quoted deals found yet for ${new Date().getFullYear()}. Product analytics populate automatically once deals reach the quote stage with line items.</td></tr>`;
      return;
    }

    const maxCW = Math.max(...sorted.map(p => p.cwRevenue), 1);

    el.innerHTML = sorted.map((p, i) => {
      const barPct = Math.round((p.cwRevenue / maxCW) * 100);
      return `<tr class="pt-row fade-up" style="animation-delay:${i * 30}ms">
        ${COLS.map(c => {
          if (c.key === "name") {
            return `<td class="${c.cls}">
              <div class="pt-name-wrap">
                <span class="pt-product-name">${c.fmt(p[c.key])}</span>
                ${p.isRecurring ? '<span class="pt-badge-recurring">↻ Recurring</span>' : ''}
              </div>
              <div class="pt-bar-bg"><div class="pt-bar-fill" style="width:${barPct}%"></div></div>
            </td>`;
          }
          const val = c.fmt(p[c.key]);
          const isEmpty = p[c.key] === 0 || p[c.key] == null;
          return `<td class="${c.cls}${isEmpty ? ' pt-zero' : ''}">${val}</td>`;
        }).join("")}
      </tr>`;
    }).join("");
  }

  function sortBy(key) {
    if (_sortKey === key) {
      _sortAsc = !_sortAsc;
    } else {
      _sortKey = key;
      _sortAsc = false;
    }
    _draw();
    // Update header arrows
    document.querySelectorAll(".pt-th-sortable").forEach(th => {
      th.classList.remove("pt-sort-asc", "pt-sort-desc");
      if (th.dataset.key === key) {
        th.classList.add(_sortAsc ? "pt-sort-asc" : "pt-sort-desc");
      }
    });
  }

  function renderLoading() {
    const el = document.getElementById("product-table-body");
    if (!el) return;
    el.innerHTML = [1,2,3,4,5].map(i => `
      <tr>
        ${COLS.map((_, j) => `<td><div class="skeleton-block" style="height:14px;width:${j===0?'80%':'50%'};margin:0"></div></td>`).join("")}
      </tr>`).join("");
  }

  function renderError(msg) {
    const el = document.getElementById("product-table-body");
    if (!el) return;
    el.innerHTML = `<tr><td colspan="${COLS.length}" class="pt-empty">⚠ ${escHtml(msg)}</td></tr>`;
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  return { render, renderLoading, renderError, sortBy };
})();
