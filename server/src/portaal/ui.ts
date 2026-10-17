import { BASIS } from "./basisstijl.js";
import type { Admin, Gebruiker } from "./gebruikers.js";

/* ─────────────────────────────────────────────── opmaakhulpjes ── */

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const EURO = new Intl.NumberFormat("nl-NL", { style: "currency", currency: "EUR" });
const GETAL = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 0 });

export const euro = (n: unknown): string => {
  const v = Number(n);
  return Number.isFinite(v) ? EURO.format(v) : "";
};
export const getal = (n: unknown): string => {
  const v = Number(n);
  return Number.isFinite(v) ? GETAL.format(v) : "";
};
export const datum = (d: unknown): string => {
  if (!d) return "";
  const x = d instanceof Date ? d : new Date(String(d));
  if (Number.isNaN(x.getTime())) return String(d);
  return new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeZone: "Europe/Amsterdam" }).format(x);
};
export const tijdstip = (d: unknown): string => {
  if (!d) return "nooit";
  const x = d instanceof Date ? d : new Date(String(d));
  return new Intl.DateTimeFormat("nl-NL", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Amsterdam" }).format(x);
};

/** "3 uur geleden" — voor de versheid van de spiegel. */
export function geleden(d: unknown): string {
  if (!d) return "nog nooit";
  const ms = Date.now() - new Date(String(d instanceof Date ? d.toISOString() : d)).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 2) return "zojuist";
  if (min < 90) return `${min} min geleden`;
  const uur = Math.round(min / 60);
  if (uur < 36) return `${uur} uur geleden`;
  return `${Math.round(uur / 24)} dagen geleden`;
}

export const adminNaam = (a: Pick<Admin, "bedrijfsnaam" | "database_name">) => a.bedrijfsnaam || `Administratie ${a.database_name}`;

/* ─────────────────────────────────────────────── iconen en menu ── */

const ICOON: Record<string, string> = {
  overzicht: '<path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-3H4zM14 7h6V4h-6z"/>',
  balans: '<path d="M12 3v18M5 7h14M7 7l-3 7a3 3 0 0 0 6 0zM17 7l-3 7a3 3 0 0 0 6 0z"/>',
  resultaat: '<path d="M4 19V5M4 19h16M8 15l3-4 3 2 5-6"/>',
  mutaties: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  relaties: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 11a3 3 0 1 0 0-6M21 20a6 6 0 0 0-4-5.6"/>',
  audit: '<path d="M9 12l2 2 4-4"/><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>',
  tabellen: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10"/>',
  wijzigingen: '<path d="M12 8v4l3 2"/><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  beheer: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  uit: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  administraties: '<path d="M4 20V8l8-4 8 4v12"/><path d="M9 20v-6h6v6M4 20h16"/>',
};
export const svg = (naam: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICOON[naam] ?? ""}</svg>`;

export type Pagina = "overzicht" | "balans" | "resultaat" | "mutaties" | "relaties" | "audit" | "tabellen" | "wijzigingen" | "beheer";

const MENU: Array<{ pagina: Pagina; pad: string; lang: string; kort: string }> = [
  { pagina: "overzicht", pad: "", lang: "Overzicht", kort: "Overzicht" },
  { pagina: "balans", pad: "/balans", lang: "Balans", kort: "Balans" },
  { pagina: "resultaat", pad: "/resultaat", lang: "Resultaat", kort: "W&V" },
  { pagina: "mutaties", pad: "/mutaties", lang: "Mutaties", kort: "Mutaties" },
  { pagina: "audit", pad: "/audit", lang: "Audit", kort: "Audit" },
  { pagina: "tabellen", pad: "/tabellen", lang: "Alle gegevens", kort: "Alles" },
];

function kopMeta(titel: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0670A3">
<meta name="apple-mobile-web-app-title" content="VDA Book">
<link rel="icon" type="image/png" href="/logo/icoon.png">
<link rel="apple-touch-icon" href="/logo/icoon.png">
<title>${esc(titel)}</title>`;
}

/* ─────────────────────────────────────────────── paginastijl ── */

const STIJL = `${BASIS}
<style>
  main { max-width:80rem; margin:0 auto; padding:1.5rem 1rem 5rem; }
  main.smal { max-width:44rem; }
  .num { font-variant-numeric: tabular-nums; white-space:nowrap; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.85em; }
  .r { text-align:right; }
  .gedempt { color:var(--gedempt); }
  header.top { display:flex; justify-content:space-between; align-items:flex-end; gap:1rem; flex-wrap:wrap; margin-bottom:.4rem; }
  h1 { font-size:1.5rem; margin:0; letter-spacing:-.01em; }
  .sub { color:var(--gedempt); font-size:.88rem; margin:.15rem 0 0; }
  h2 { font-size:.75rem; letter-spacing:.12em; text-transform:uppercase; color:var(--gedempt);
       margin:2rem 0 .5rem; display:flex; align-items:center; gap:.7rem; }
  h2::after { content:""; flex:1; height:1px; background:var(--lijn); }
  .uitleg { color:var(--gedempt); font-size:.86rem; margin:0 0 .9rem; max-width:75ch; }
  .bericht { border-radius:8px; padding:.7rem .9rem; font-size:.9rem; margin:1rem 0; }
  .bericht.ok { background:var(--accent-zacht); color:var(--accent); border:1px solid var(--accent); }
  .bericht.mis { background:var(--risico-zacht); color:var(--risico); border:1px solid var(--risico); }
  .bericht.let { background:var(--wacht-zacht); color:var(--wacht); border:1px solid var(--wacht); }

  .tegels { display:grid; grid-template-columns:repeat(auto-fill, minmax(15rem, 1fr)); gap:.75rem; }
  .tegel { background:var(--vlak); border:1px solid var(--lijn); border-radius:12px; padding:1rem 1.1rem; text-decoration:none; color:var(--inkt); display:block; }
  a.tegel:hover { border-color:var(--accent); }
  .tegel .label { font-size:.72rem; letter-spacing:.1em; text-transform:uppercase; color:var(--gedempt); }
  .tegel .waarde { font-size:1.45rem; font-weight:650; margin-top:.2rem; font-variant-numeric:tabular-nums; }
  .tegel .noot { font-size:.8rem; color:var(--gedempt); margin-top:.2rem; }
  .tegel.groot .titel { font-size:1.1rem; font-weight:650; }
  .pos { color:var(--accent); } .neg { color:var(--risico); }

  .kaart { background:var(--vlak); border:1px solid var(--lijn); border-radius:12px; overflow:hidden; }
  .schuif { overflow-x:auto; }
  table.lijst { width:100%; border-collapse:collapse; font-size:.88rem; }
  table.lijst th { text-align:left; font-size:.72rem; letter-spacing:.06em; text-transform:uppercase; color:var(--gedempt);
                   font-weight:600; padding:.55rem .7rem; border-bottom:1px solid var(--lijn); background:var(--paper); white-space:nowrap; }
  table.lijst td { padding:.45rem .7rem; border-bottom:1px solid var(--lijn); vertical-align:top; }
  table.lijst tr:last-child td { border-bottom:none; }
  table.lijst tr.totaal td { font-weight:700; border-top:2px solid var(--lijn); background:var(--paper); }
  table.lijst tr.kop td { font-weight:650; background:var(--paper); color:var(--gedempt); font-size:.78rem; letter-spacing:.06em; text-transform:uppercase; }
  table.lijst a { text-decoration:none; }
  table.lijst a:hover { text-decoration:underline; }
  table.lijst td.r, table.lijst th.r { text-align:right; }

  form.filter { display:flex; gap:.5rem; flex-wrap:wrap; align-items:flex-end; margin:1rem 0; }
  form.filter label { display:grid; gap:.2rem; font-size:.75rem; color:var(--gedempt); }
  input, select, textarea { font:inherit; font-size:.88rem; padding:.42rem .55rem; border:1px solid var(--lijn); border-radius:7px;
                            background:var(--vlak); color:var(--inkt); }
  main button, a.knop { font:inherit; font-size:.86rem; padding:.45rem .9rem; border-radius:7px; cursor:pointer;
                        border:1px solid var(--lijn); background:var(--vlak); color:var(--inkt); text-decoration:none; display:inline-block; }
  main button.primair, a.knop.primair { background:var(--accent); color:var(--op-accent); border-color:var(--accent); font-weight:600; }
  main button.klein { padding:.25rem .55rem; font-size:.78rem; }
  .knoppen { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }

  .badge { display:inline-block; font-size:.72rem; font-weight:650; padding:.1rem .5rem; border-radius:99px;
           border:1px solid var(--lijn); color:var(--gedempt); background:var(--paper); white-space:nowrap; }
  .badge.ok { color:var(--accent); border-color:var(--accent); background:var(--accent-zacht); }
  .badge.let { color:var(--wacht); border-color:var(--wacht); background:var(--wacht-zacht); }
  .badge.mis { color:var(--risico); border-color:var(--risico); background:var(--risico-zacht); }
  .leeg { color:var(--gedempt); padding:1.75rem 1rem; text-align:center; background:var(--vlak); border:1px solid var(--lijn); border-radius:10px; }
  .paginering { display:flex; gap:.5rem; justify-content:space-between; align-items:center; margin-top:.7rem; font-size:.85rem; color:var(--gedempt); }
  details.diff summary { cursor:pointer; color:var(--accent); font-size:.82rem; }
  .diff table { font-size:.8rem; margin-top:.4rem; }
  del { color:var(--risico); } ins { color:var(--accent); text-decoration:none; }

  .controles { display:grid; grid-template-columns:repeat(auto-fill, minmax(18rem, 1fr)); gap:.6rem; }
  .controle { background:var(--vlak); border:1px solid var(--lijn); border-left:3px solid var(--lijn); border-radius:10px;
              padding:.8rem 1rem; text-decoration:none; color:var(--inkt); display:block; }
  .controle:hover { border-color:var(--accent); }
  .controle.open { border-left-color:var(--wacht); }
  .controle.schoon { border-left-color:var(--accent); }
  .controle .titel { font-weight:650; }
  .controle .tel { font-size:.82rem; color:var(--gedempt); margin-top:.25rem; }
  form.beoordeel { display:flex; gap:.3rem; flex-wrap:wrap; margin:0; }
  form.beoordeel input[name=opmerking] { min-width:10rem; flex:1; font-size:.8rem; padding:.25rem .45rem; }
  form.beoordeel select { font-size:.8rem; padding:.25rem .3rem; }

  @media (max-width: 640px) {
    main { padding-top:1rem; }
    h1 { font-size:1.3rem; }
    input, select, textarea { font-size:16px; }
  }
</style>`;

/* ─────────────────────────────────────────────── kop en kader ── */

export interface Kader {
  titel: string;
  g: Gebruiker;
  admins: Admin[];
  /** Huidige administratie, als de pagina over één administratie gaat. */
  admin?: Admin | null;
  actief?: Pagina | null;
  /** Voor de administratiekeuze: welk subpad bij wisselen behouden blijft. */
  subpad?: string;
  smal?: boolean;
}

export function kader(k: Kader, inhoud: string): string {
  const basis = k.admin ? `/a/${encodeURIComponent(k.admin.slug)}` : "";
  const nav = k.admin
    ? MENU.map(
        (m) =>
          `<a href="${basis}${m.pad || "/"}"${m.pagina === k.actief ? ' aria-current="page"' : ""}>${svg(m.pagina)}<span class="lang">${esc(m.lang)}</span><span class="kort">${esc(m.kort)}</span></a>`,
      ).join("")
    : "";

  const kiezer =
    k.admins.length > 0
      ? `<details class="adm-kiezer">
        <summary title="Administratie">${svg("administraties")}<span class="adm-naam">${esc(k.admin ? adminNaam(k.admin) : "Kies administratie")}</span></summary>
        <div class="adm-lijst"><ul>${k.admins
          .map((a) =>
            k.admin && a.admin_key === k.admin.admin_key
              ? `<li><span class="gekozen" aria-current="true">${esc(adminNaam(a))}</span></li>`
              : `<li><a class="keuze" href="/a/${encodeURIComponent(a.slug)}${esc(k.subpad ?? "/")}">${esc(adminNaam(a))}${a.afgeschermd ? " 🔒" : ""}</a></li>`,
          )
          .join("")}</ul><a href="/">Alle administraties</a></div>
      </details>`
      : "";

  const beheer =
    k.g.rol === "beheerder"
      ? `<a href="/beheer"${k.actief === "beheer" ? ' aria-current="page"' : ""} title="Beheer">${svg("beheer")}<span class="tekst">Beheer</span></a>`
      : "";

  return `<!doctype html>
<html lang="nl">
<head>
${kopMeta(`${k.titel} — VDA Book`)}
${STIJL}
<style>.adm-kiezer li a.keuze { display:flex; width:100%; font-size:.9rem; padding:.5rem .6rem; border-radius:7px; color:var(--inkt); text-decoration:none; }
.adm-kiezer li a.keuze:hover { background:var(--paper); }</style>
</head>
<body>
<header class="app-kop">
  <div class="binnen">
    <a class="merk" href="/" aria-label="VDA Book — naar het overzicht">
      <img class="bm" src="/logo/beeldmerk.png" alt="" width="30" height="30">
      <img class="wm" src="/logo/woordmerk.png" alt="Van den Dungen Consultancy" width="116" height="22">
      <span class="app-naam">VDA Book</span>
    </a>
    <nav class="hoofdnav" aria-label="Hoofdmenu">${nav}</nav>
    <div class="kop-rechts">
      ${kiezer}
      ${beheer}
      <form method="post" action="/uitloggen"><button title="Uitloggen (${esc(k.g.naam)})">${svg("uit")}<span class="tekst">Uitloggen</span></button></form>
    </div>
  </div>
</header>
<main${k.smal ? ' class="smal"' : ""}>
${inhoud}
</main>
</body>
</html>`;
}

/** Kaal kader voor inloggen, setup en uitnodiging. */
export function losKader(titel: string, inhoud: string): string {
  return `<!doctype html>
<html lang="nl">
<head>
${kopMeta(`${titel} — VDA Book`)}
${STIJL}
<style>
  main.inlog { max-width:24rem; padding-top:clamp(2rem, 8vh, 4.5rem); }
  .inlog .logo { display:block; margin:0 auto 1.4rem; text-align:center; }
  .inlog .logo .bm { width:56px; height:56px; display:block; margin:0 auto .7rem; }
  .inlog .logo .wm { height:30px; width:auto; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .inlog .wm { filter:brightness(0) invert(.9); } }
  .inlog form, .inlog .vak { background:var(--vlak); border:1px solid var(--lijn); border-radius:12px; padding:1.2rem; display:flex; flex-direction:column; gap:.7rem; }
  .inlog label { font-size:.8rem; color:var(--gedempt); display:block; margin-bottom:.2rem; }
  .inlog input { width:100%; font-size:16px; padding:.6rem .7rem; border-radius:8px; background:var(--paper); }
  .inlog input[name="code"] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.35em; text-align:center; }
  .inlog button { font:inherit; padding:.7rem 1rem; border-radius:8px; cursor:pointer; background:var(--accent); color:var(--op-accent); border:1px solid var(--accent); font-weight:600; }
  .inlog h1 { font-size:1.2rem; margin:0 0 .3rem; }
  .inlog .sub { margin:0 0 1rem; }
  .qr { background:#fff; padding:.6rem; border-radius:8px; width:200px; height:200px; margin:0 auto; }
  .qr svg { width:100%; height:100%; display:block; }
  .geheim { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.8rem; word-break:break-all; text-align:center; color:var(--gedempt); }
</style>
</head>
<body>
<main class="inlog">
  <div class="logo">
    <img class="bm" src="/logo/beeldmerk.png" alt="" width="56" height="56">
    <img class="wm" src="/logo/woordmerk.png" alt="Van den Dungen Consultancy" width="158" height="30">
  </div>
${inhoud}
</main>
</body>
</html>`;
}

export function meldingen(q: { ok?: unknown; fout?: unknown }): string {
  return (
    (typeof q.ok === "string" && q.ok ? `<div class="bericht ok">${esc(q.ok)}</div>` : "") +
    (typeof q.fout === "string" && q.fout ? `<div class="bericht mis">${esc(q.fout)}</div>` : "")
  );
}

/** Bedrag in een cel, rechts uitgelijnd, negatief in de risicokleur. */
export function bedragCel(n: unknown, extra = ""): string {
  const v = Number(n);
  if (n === null || n === undefined || !Number.isFinite(v)) return `<td class="r num"${extra}></td>`;
  return `<td class="r num${v < 0 ? " neg" : ""}"${extra}>${euro(v)}</td>`;
}

/** Querystring opbouwen met de huidige filters, één waarde aangepast. */
export function qs(basis: Record<string, unknown>, wijzig: Record<string, unknown> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...basis, ...wijzig })) {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}
