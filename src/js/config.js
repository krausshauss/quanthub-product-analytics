window.CONFIG = {
  WORKER_URL: "https://quanthub-products-dev.michael-20e.workers.dev",
  YEAR:       new Date().getFullYear().toString(),

  // Currency formatter
  fmtMoney(n) {
    const v = parseFloat(n) || 0;
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
    return `$${v.toFixed(0)}`;
  },

  fmtNum(n) {
    return Number(n || 0).toLocaleString();
  },
};
