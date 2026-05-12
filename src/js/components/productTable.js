/**
 * productTable.js
 * Main product performance table — sortable columns, paginated to fit the
 * available vertical space (sized against the right column's height).
 */
window.ProductTable = (() => {

  let _products = [];
  let _sortKey  = "cwRevenue";
  let _sortAsc  = false;
  let _page     = 1;
  let _pageSize = 10;          // initial guess; recalculated after first paint
  let _resizeObs = null;

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
    _page = 1;
    _draw();
    _ensureResizeObserver();
  }

  function _sortedAll() {
    return [..._products]
      .map(p => ({
        ...p,
        winRate: p.totalDeals > 0 ? Math.round((p.dealCount / p.totalDeals) * 100) : null,
      }))
      .sort((a, b) => {
        const av = a[_sortKey] ?? -1;
        const bv = b[_sortKey] ?? -1;
        return _sortAsc ? av - bv : bv - av;
      });
  }

  function _draw() {
    const el = document.getElementById("product-table-body");
    if (!el) return;

    const sorted = _sortedAll();

    if (!sorted.length) {
      el.innerHTML = `<tr><td colspan="${COLS.length}" class="pt-empty">No quoted deals found yet for ${new Date().getFullYear()}. Product analytics populate automatically once deals reach the quote stage with line items.</td></tr>`;
      _renderPagination(0, 0);
      return;
    }

    const totalPages = Math.max(1, Math.ceil(sorted.length / _pageSize));
    if (_page > totalPages) _page = totalPages;
    const start = (_page - 1) * _pageSize;
    const slice = sorted.slice(start, start + _pageSize);

    const maxCW = Math.max(...sorted.map(p => p.cwRevenue), 1);

    el.innerHTML = slice.map((p, i) => {
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

    _renderPagination(totalPages, sorted.length, start, slice.length);
    requestAnimationFrame(_recomputePageSize);
  }

  function _renderPagination(totalPages, totalCount, start = 0, shown = 0) {
    const el = document.getElementById("product-table-pagination");
    if (!el) return;
    if (totalCount === 0 || totalPages <= 1) { el.innerHTML = ""; return; }
    const first = start + 1;
    const last  = start + shown;
    el.innerHTML = `
      <span class="tp-info">Showing ${first}–${last} of ${totalCount}</span>
      <span class="tp-pager">
        <button class="tp-btn" ${_page === 1 ? "disabled" : ""} onclick="ProductTable.prevPage()">‹ Prev</button>
        <span class="tp-page">${_page} of ${totalPages}</span>
        <button class="tp-btn" ${_page === totalPages ? "disabled" : ""} onclick="ProductTable.nextPage()">Next ›</button>
      </span>`;
  }

  function _recomputePageSize() {
    const wrap = document.querySelector(".panel-table .table-wrap");
    if (!wrap) return;
    const firstRow = wrap.querySelector("tbody tr.pt-row");
    if (!firstRow) return;
    const rowH = firstRow.offsetHeight;
    if (rowH <= 0) return;
    // Available space for rows (clientHeight already excludes the sticky thead area).
    const thead = wrap.querySelector("thead");
    const headH = thead ? thead.offsetHeight : 0;
    const capacity = Math.max(3, Math.floor((wrap.clientHeight - headH) / rowH));
    if (capacity !== _pageSize) {
      _pageSize = capacity;
      _draw();
    }
  }

  function _ensureResizeObserver() {
    if (_resizeObs || typeof ResizeObserver !== "function") return;
    const wrap = document.querySelector(".panel-table .table-wrap");
    if (!wrap) return;
    _resizeObs = new ResizeObserver(() => _recomputePageSize());
    _resizeObs.observe(wrap);
  }

  function sortBy(key) {
    if (_sortKey === key) {
      _sortAsc = !_sortAsc;
    } else {
      _sortKey = key;
      _sortAsc = false;
    }
    _page = 1;
    _draw();
    document.querySelectorAll(".pt-th-sortable").forEach(th => {
      th.classList.remove("pt-sort-asc", "pt-sort-desc");
      if (th.dataset.key === key) {
        th.classList.add(_sortAsc ? "pt-sort-asc" : "pt-sort-desc");
      }
    });
  }

  function prevPage() { if (_page > 1) { _page -= 1; _draw(); } }
  function nextPage() {
    const total = Math.max(1, Math.ceil(_sortedAll().length / _pageSize));
    if (_page < total) { _page += 1; _draw(); }
  }

  function renderLoading() {
    const el = document.getElementById("product-table-body");
    if (!el) return;
    el.innerHTML = [1,2,3,4,5].map(i => `
      <tr>
        ${COLS.map((_, j) => `<td><div class="skeleton-block" style="height:14px;width:${j===0?'80%':'50%'};margin:0"></div></td>`).join("")}
      </tr>`).join("");
    const pg = document.getElementById("product-table-pagination");
    if (pg) pg.innerHTML = "";
  }

  function renderError(msg) {
    const el = document.getElementById("product-table-body");
    if (!el) return;
    el.innerHTML = `<tr><td colspan="${COLS.length}" class="pt-empty">⚠ ${escHtml(msg)}</td></tr>`;
    const pg = document.getElementById("product-table-pagination");
    if (pg) pg.innerHTML = "";
  }

  function escHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  return { render, renderLoading, renderError, sortBy, prevPage, nextPage };
})();
