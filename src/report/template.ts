export function getReportCss(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #58a6ff; margin-bottom: 8px; font-size: 24px; }
    h2 { color: #79c0ff; margin: 24px 0 12px; font-size: 18px; border-bottom: 1px solid #21262d; padding-bottom: 8px; }
    .subtitle { color: #8b949e; font-size: 14px; margin-bottom: 24px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin: 16px 0; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; text-align: center; }
    .card .value { font-size: 32px; font-weight: bold; color: #58a6ff; }
    .card .label { font-size: 12px; color: #8b949e; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th { background: #161b22; padding: 8px 12px; text-align: left; font-size: 13px; color: #8b949e; border-bottom: 1px solid #30363d; cursor: pointer; }
    th:hover { color: #58a6ff; }
    td { padding: 8px 12px; border-bottom: 1px solid #21262d; font-size: 13px; }
    tr:hover td { background: #161b22; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; margin: 1px 2px; }
    .tag-hub { background: #1f6feb33; color: #58a6ff; }
    .tag-orphan { background: #da363433; color: #f85149; }
    .insight { padding: 12px 16px; margin: 8px 0; border-radius: 6px; border-left: 3px solid; }
    .insight-error { background: #da363410; border-color: #f85149; }
    .insight-warning { background: #d29922; border-color: #d29922; background: #d2992210; }
    .insight-info { background: #58a6ff10; border-color: #58a6ff; }
    .insight .title { font-weight: 600; font-size: 14px; }
    .insight .desc { font-size: 13px; color: #8b949e; margin-top: 4px; }
    .severity { text-transform: uppercase; font-size: 11px; font-weight: bold; padding: 2px 6px; border-radius: 4px; }
    .severity-error { background: #da363433; color: #f85149; }
    .severity-warning { background: #d2992233; color: #d29922; }
    .severity-info { background: #58a6ff33; color: #58a6ff; }
    .mermaid { background: #161b22; border-radius: 8px; padding: 16px; margin: 12px 0; overflow-x: auto; }
    .search { padding: 8px 16px; border: 1px solid #30363d; border-radius: 6px; background: #0d1117; color: #c9d1d9; width: 300px; margin: 12px 0; font-size: 14px; }
    .search:focus { outline: none; border-color: #58a6ff; }
    .coverage-bar { height: 8px; background: #21262d; border-radius: 4px; overflow: hidden; margin: 4px 0; }
    .coverage-fill { height: 100%; border-radius: 4px; }
    .coverage-good { background: #3fb950; }
    .coverage-medium { background: #d29922; }
    .coverage-low { background: #f85149; }
    .collapsible { cursor: pointer; user-select: none; }
    .collapsible::before { content: '\\25B6 '; font-size: 10px; }
    .collapsible.open::before { content: '\\25BC '; }
    .collapse-content { display: none; }
    .collapse-content.show { display: block; }
    footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #21262d; color: #484f58; font-size: 12px; text-align: center; }
  `;
}

export function getReportJs(): string {
  return `
    // Table sorting
    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const table = th.closest('table');
        const tbody = table.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const col = th.cellIndex;
        const isNum = th.dataset.sort === 'number';
        const asc = th.dataset.dir !== 'asc';
        th.dataset.dir = asc ? 'asc' : 'desc';
        rows.sort((a, b) => {
          const av = a.cells[col].textContent.trim();
          const bv = b.cells[col].textContent.trim();
          if (isNum) return asc ? Number(av) - Number(bv) : Number(bv) - Number(av);
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
        rows.forEach(r => tbody.appendChild(r));
      });
    });

    // Search filter
    const search = document.getElementById('component-search');
    if (search) {
      search.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        document.querySelectorAll('#component-table tbody tr').forEach(row => {
          row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
    }

    // Collapsible sections
    document.querySelectorAll('.collapsible').forEach(el => {
      el.addEventListener('click', () => {
        el.classList.toggle('open');
        const content = el.nextElementSibling;
        if (content) content.classList.toggle('show');
      });
    });

    // Mermaid init
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({ startOnLoad: true, theme: 'dark', securityLevel: 'loose' });
    }
  `;
}
