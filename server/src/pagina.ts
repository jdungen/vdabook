/** De twee schermen die een mens ziet: toestemming geven en een foutmelding. */

const e = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STIJL = `
  :root { color-scheme: light dark; --bg:#f6f7f8; --kaart:#fff; --tekst:#1d2327; --zacht:#5f6b73; --rand:#d9dee2; --knop:#32373c; --fout:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16191c; --kaart:#1f2327; --tekst:#e8ebed; --zacht:#9aa5ad; --rand:#343a40; --knop:#e8ebed; --fout:#f97066; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--tekst);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding:16px; }
  main { width:100%; max-width:420px; background:var(--kaart); border:1px solid var(--rand); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p { margin:0 0 16px; color:var(--zacht); }
  label { display:block; font-size:14px; font-weight:600; margin:14px 0 6px; }
  input { width:100%; font:inherit; padding:10px 12px; border:1px solid var(--rand); border-radius:8px; background:transparent; color:inherit; }
  .knoppen { display:flex; gap:8px; margin-top:20px; }
  button { flex:1; font:inherit; font-weight:600; padding:10px; border-radius:8px; border:1px solid var(--knop); cursor:pointer; }
  .ja { background:var(--knop); color:var(--kaart); }
  .nee { background:transparent; color:var(--tekst); }
  .fout { color:var(--fout); font-weight:600; }
  code { font-size:13px; }
`;

function kader(titel: string, inhoud: string): string {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(titel)}</title><style>${STIJL}</style></head><body><main>${inhoud}</main></body></html>`;
}

export function foutPagina(melding: string): string {
  return kader("Globe-spiegel", `<h1>Globe-spiegel</h1><p class="fout">${e(melding)}</p>`);
}
