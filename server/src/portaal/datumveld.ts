import type express from "express";

/**
 * Datumvelden in Nederlandse notatie (dd-mm-jjjj).
 *
 * Een native <input type="date"> toont de datum in de taal van de browser of
 * het besturingssysteem, niet van de pagina: op een Engelstalige Chrome of Mac
 * wordt dat mm/dd/jjjj. Daarom is het zichtbare veld een tekstveld met
 * dd-mm-jjjj; een knop ernaast opent de kalender van de browser (een verborgen
 * date-input zonder name) en zet de gekozen datum in het tekstveld.
 *
 * De server krijgt dus dd-mm-jjjj binnen. `datumInvoerNaarIso` zet dat vóór de
 * routes om naar jjjj-mm-dd, zodat handlers en database ongewijzigd blijven.
 * Een ongeldige datum (31-02-2026) blijft staan zoals getypt en valt daarna
 * gewoon door de bestaande validatie.
 *
 * Dit bestand is letterlijk gelijk in de strippenkaart-app, VDA Automaten,
 * VDA Book en de SnelStart-tool.
 */

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const NL = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})/;

const pad = (n: number) => String(n).padStart(2, "0");

/** "7-3-2026", "07/03/2026" of "07.03.2026" → "2026-03-07"; anders null. */
export function nlNaarIso(v: unknown): string | null {
  const m = NL.exec(String(v ?? "").trim());
  if (!m) return null;
  const d = +m[1]!, mnd = +m[2]!, j = +m[3]!;
  const x = new Date(Date.UTC(j, mnd - 1, d));
  return x.getUTCFullYear() === j && x.getUTCMonth() === mnd - 1 && x.getUTCDate() === d ? `${j}-${pad(mnd)}-${pad(d)}` : null;
}

/** "2026-03-07" (of een Date) → "07-03-2026"; leeg blijft leeg, iets anders blijft zoals het is. */
export function isoNaarNl(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  const m = ISO.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}

export interface DatumVeldOpties {
  required?: boolean;
  /** Extra attributen op het zichtbare veld, al ge-escaped (bijv. `form="x"`). */
  attr?: string;
  /** Zichtbare naam voor schermlezers als het veld niet in een <label> staat. */
  ariaLabel?: string;
}

/**
 * Datumveld met waarde in jjjj-mm-dd (zoals de database het geeft); het veld
 * toont en verstuurt dd-mm-jjjj. Zet het binnen een <label> zoals een gewoon veld.
 */
export function datumVeld(naam: string, iso: unknown, o: DatumVeldOpties = {}): string {
  const isoWaarde = ISO.exec(v(iso))?.[0] ?? "";
  return `<span class="datumveld"><input type="text" name="${esc(naam)}" value="${esc(isoNaarNl(iso))}" placeholder="dd-mm-jjjj" inputmode="numeric" autocomplete="off" pattern="\\d{1,2}[\\-\\/.]\\d{1,2}[\\-\\/.]\\d{4}" title="Datum als dd-mm-jjjj"${o.required ? " required" : ""}${o.ariaLabel ? ` aria-label="${esc(o.ariaLabel)}"` : ""}${o.attr ? ` ${o.attr}` : ""}><button type="button" class="datumknop" title="Kies een datum" aria-label="Kies een datum" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></button><input type="date" class="datumkiezer" tabindex="-1" aria-hidden="true" value="${esc(isoWaarde)}"></span>`;
}
const v = (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x ?? ""));

/** Stijl voor het veld; hoort in de pagina-stijl van de app. */
export const DATUMVELD_STIJL = `
  .datumveld { position:relative; display:flex; align-items:stretch; gap:.35rem; }
  .datumveld > input[type=text] { flex:1; min-width:0; font-variant-numeric:tabular-nums; }
  .datumveld .datumknop { flex:none; display:inline-grid; place-items:center; padding:0 .55rem; min-width:2.4rem; margin:0;
      background:var(--vlak); color:var(--gedempt); border:1px solid var(--lijn); border-radius:8px; box-shadow:none; cursor:pointer; }
  .datumveld .datumknop:hover { background:var(--paper); color:var(--inkt); }
  .datumveld .datumknop[hidden] { display:none; }
  .datumveld .datumknop svg { width:18px; height:18px; }
  .knoppen .datumveld { display:inline-flex; vertical-align:middle; }
  .knoppen .datumveld > input[type=text] { flex:none; width:8.5rem; }
  .datumveld .datumkiezer { position:absolute; right:0; bottom:0; width:1px; height:1px; opacity:0; pointer-events:none; border:0; padding:0; }
`;

/** Klein script: kalenderknop tonen en koppelen. Zonder script werkt typen gewoon. */
const DATUMVELD_SCRIPT = `(()=>{const iso=s=>{const m=/^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4})$/.exec((s||'').trim());if(!m)return'';const p=n=>String(n).padStart(2,'0');return m[3]+'-'+p(+m[2])+'-'+p(+m[1]);};document.querySelectorAll('.datumveld').forEach(w=>{const t=w.querySelector('input[type=text]'),k=w.querySelector('.datumkiezer'),b=w.querySelector('.datumknop');if(!t||!k||!b)return;if(typeof k.showPicker!=='function')return;b.hidden=false;b.addEventListener('click',()=>{k.value=iso(t.value);try{k.showPicker();}catch(e){k.focus();}});k.addEventListener('change',()=>{const m=/^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(k.value);if(m){t.value=m[3]+'-'+m[2]+'-'+m[1];t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));}});});})();`;

/**
 * Middleware: dd-mm-jjjj in formulier- en querywaarden wordt jjjj-mm-dd.
 * Na de body-parser plaatsen. Zet ook het kalenderscript in elke HTML-pagina
 * met een datumveld, met de nonce van dit verzoek. Zonder nonce (CSP zonder
 * scripts) geen script: het veld blijft dan een gewoon tekstveld.
 */
export function datumInvoerNaarIso(nonceVan: (req: express.Request) => string | undefined = (req) => (req as { nonce?: string }).nonce) {
  const omzetten = (o: unknown): unknown => {
    if (typeof o === "string") return nlNaarIso(o) ?? o;
    if (Array.isArray(o)) return o.map(omzetten);
    if (o && typeof o === "object") {
      for (const [k, w] of Object.entries(o)) (o as Record<string, unknown>)[k] = omzetten(w);
    }
    return o;
  };
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) omzetten(req.body);
    const q = req.query;
    if (q && Object.values(q).some((w) => typeof w === "string" && NL.test(w.trim()))) {
      const kopie = omzetten({ ...q }) as typeof q;
      Object.defineProperty(req, "query", { value: kopie, writable: true, configurable: true, enumerable: true });
    }
    const send = res.send.bind(res);
    res.send = (body?: unknown) => {
      if (typeof body === "string" && body.includes('class="datumveld"') && body.includes("</body>")) {
        // Zonder nonce zou de CSP het script toch blokkeren; dan blijft het een tekstveld.
        const n = nonceVan(req);
        if (n) {
          const i = body.lastIndexOf("</body>");
          body = `${body.slice(0, i)}<script nonce="${esc(n)}">${DATUMVELD_SCRIPT}</script>${body.slice(i)}`;
        }
      }
      return send(body as never);
    };
    next();
  };
}
