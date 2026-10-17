/**
 * Basisstijl van de VDDC-portalen, overgenomen uit de SnelStart-portal zodat
 * beide er hetzelfde uitzien: huisstijlkleuren, kop met navigatie, tabbalk op
 * de telefoon, tabellen die kaartjes worden. Pas hier niets aan zonder het
 * daar ook te doen.
 */

const DONKER_TOKENS = `
    --paper:#111518; --vlak:#1A1F24; --inkt:#E6EAEE; --gedempt:#98A2AB; --lijn:#2A3138;
    --accent:#4AAEE0; --accent-zacht:#12283A; --op-accent:#08141C;
    --wacht:#D8A83E; --wacht-zacht:#2E2716; --risico:#E07B62; --risico-zacht:#33201B;`;

/**
 * Basis voor elk scherm: VDDC-huisstijlkleuren (logo-blauw #0670A3), font,
 * en de kop/navigatie. Pagina-specifieke stijl komt hierna.
 */
export const BASIS = `<style>
  :root {
    --paper:#F4F7F9; --vlak:#FFF; --inkt:#26292C; --gedempt:#6B6B6E; --lijn:#DCE4EA;
    --accent:#0670A3; --accent-zacht:#E9F4FA; --op-accent:#FFF;
    --wacht:#A9770F; --wacht-zacht:#F5EBD4; --risico:#B3452F; --risico-zacht:#F6E3DE;
    --tabbalk:0px;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {${DONKER_TOKENS} } }
  :root[data-theme="dark"] {${DONKER_TOKENS} }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--paper); color:var(--inkt);
    font:16px/1.55 "Source Sans 3", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    padding-bottom:var(--tabbalk); }
  a { color:var(--accent); }
  button:focus-visible, select:focus-visible, a:focus-visible, input:focus-visible {
    outline:2px solid var(--accent); outline-offset:2px; }

  .app-kop { position:sticky; top:0; z-index:20; background:var(--vlak); border-bottom:1px solid var(--lijn);
             padding-top:env(safe-area-inset-top); }
  .app-kop .binnen { max-width:80rem; margin:0 auto; display:flex; align-items:center; gap:1.25rem;
                     padding:.5rem max(1rem, env(safe-area-inset-right)) .5rem max(1rem, env(safe-area-inset-left)); }
  .merk { display:flex; align-items:center; gap:.55rem; text-decoration:none; color:var(--inkt); flex-shrink:0; }
  .merk .bm { width:30px; height:30px; }
  .merk .wm { width:auto; height:22px; }
  .merk .app-naam { font-size:.78rem; color:var(--gedempt); border-left:1px solid var(--lijn); padding-left:.55rem;
                    letter-spacing:.04em; text-transform:uppercase; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .merk .wm { filter:brightness(0) invert(.9); } }
  :root[data-theme="dark"] .merk .wm { filter:brightness(0) invert(.9); }

  .hoofdnav { display:flex; gap:.15rem; }
  .hoofdnav a { position:relative; display:flex; align-items:center; gap:.4rem; padding:.42rem .65rem; border-radius:8px;
                color:var(--gedempt); text-decoration:none; font-size:.9rem; font-weight:600; white-space:nowrap; }
  .hoofdnav a:hover { background:var(--paper); color:var(--inkt); }
  .hoofdnav a[aria-current="page"] { background:var(--accent-zacht); color:var(--accent); }
  .hoofdnav svg, .kop-rechts svg { width:18px; height:18px; flex-shrink:0; }
  .hoofdnav .kort { display:none; }
  .teller { display:inline-grid; place-items:center; min-width:1.2rem; height:1.2rem; padding:0 .3rem;
            border-radius:99px; background:var(--wacht); color:var(--vlak); font-size:.68rem; font-weight:700; line-height:1; }

  .kop-rechts { display:flex; align-items:center; gap:.4rem; margin-left:auto; }
  .kop-rechts form { margin:0; }
  .kop-rechts a, .kop-rechts button { display:flex; align-items:center; gap:.35rem; font:inherit; font-size:.84rem;
      color:var(--gedempt); background:none; border:none; padding:.42rem .55rem; border-radius:8px; cursor:pointer; text-decoration:none; }
  .kop-rechts a:hover, .kop-rechts button:hover { background:var(--paper); color:var(--inkt); }
  .kop-rechts a[aria-current="page"] { color:var(--accent); }

  /* Administratiekeuze in de kop. */
  .adm-kiezer { position:relative; }
  .adm-kiezer summary { list-style:none; display:flex; align-items:center; gap:.35rem; cursor:pointer;
      font-size:.84rem; font-weight:600; color:var(--inkt); padding:.42rem .6rem; border-radius:8px;
      border:1px solid var(--lijn); max-width:14rem; }
  .adm-kiezer summary::-webkit-details-marker { display:none; }
  .adm-kiezer summary svg { width:18px; height:18px; flex-shrink:0; color:var(--accent); }
  .adm-kiezer .adm-naam { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .adm-kiezer .adm-lijst { position:absolute; right:0; top:calc(100% + .3rem); z-index:40; min-width:15rem;
      background:var(--vlak); border:1px solid var(--lijn); border-radius:10px; padding:.35rem;
      box-shadow:0 6px 24px rgba(0,0,0,.12); }
  .adm-kiezer ul { list-style:none; margin:0; padding:0; }
  .adm-kiezer li form { margin:0; }
  .adm-kiezer li button, .adm-kiezer li .gekozen, .adm-kiezer .adm-lijst > a {
      display:flex; align-items:center; justify-content:space-between; gap:.5rem; width:100%;
      font:inherit; font-size:.9rem; text-align:left; padding:.5rem .6rem; border-radius:7px;
      border:none; background:none; color:var(--inkt); cursor:pointer; text-decoration:none; }
  .adm-kiezer li button:hover, .adm-kiezer .adm-lijst > a:hover { background:var(--paper); }
  .adm-kiezer li .gekozen { color:var(--accent); font-weight:700; background:var(--accent-zacht); cursor:default; }
  .adm-kiezer .adm-lijst > a { color:var(--gedempt); font-size:.82rem; border-top:1px solid var(--lijn);
      border-radius:0 0 7px 7px; margin-top:.25rem; }
  @media (max-width: 760px) { .adm-kiezer summary { max-width:9rem; padding:.5rem; } }

  /* Smalle schermen eerst de kop inkorten… */
  @media (max-width: 1400px) { .kop-rechts .tekst { display:none; } }
  @media (max-width: 1240px) { .merk .app-naam { display:none; } }
  @media (max-width: 900px)  { .merk .wm { display:none; } }

  /* …en op een telefoon wordt de navigatie een tabbalk onderin. */
  @media (max-width: 760px) {
    :root { --tabbalk: calc(3.9rem + env(safe-area-inset-bottom)); }
    .merk .wm { display:block; }
    .hoofdnav { position:fixed; left:0; right:0; bottom:0; z-index:30; background:var(--vlak);
                border-top:1px solid var(--lijn); gap:0; justify-content:space-around;
                padding:.25rem .25rem calc(.25rem + env(safe-area-inset-bottom)); }
    .hoofdnav a { flex:1 1 0; min-width:0; flex-direction:column; gap:.1rem; padding:.4rem .1rem;
                  font-size:.68rem; font-weight:600; text-align:center; }
    .hoofdnav a[aria-current="page"] { background:none; }
    .hoofdnav a[aria-current="page"] svg { stroke-width:2.3; }
    .hoofdnav svg { width:23px; height:23px; }
    .hoofdnav .lang { display:none; }
    .hoofdnav .kort { display:block; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
    .hoofdnav .teller { position:absolute; top:.15rem; left:calc(50% + 5px); }
    .kop-rechts a, .kop-rechts button { padding:.55rem; }
    .kop-rechts svg { width:21px; height:21px; }
  }

  /* Tabellen worden op een telefoon kaartjes: één rij = één blok, kolomnaam ervoor. */
  @media (max-width: 640px) {
    table.kaarten, table.kaarten tbody, table.kaarten tr, table.kaarten td { display:block; width:100%; }
    table.kaarten tr.kopregel { display:none; }
    table.kaarten tr { padding:.6rem .8rem; border-bottom:1px solid var(--lijn); }
    table.kaarten tr:last-child { border-bottom:none; }
    table.kaarten td { border:none; padding:.12rem 0; text-align:left !important; }
    table.kaarten td[data-l]:not(:first-child)::before { content:attr(data-l) " "; color:var(--gedempt);
        font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; margin-right:.35rem; }
    table.kaarten td.acties { display:flex; gap:.45rem; padding-top:.45rem; }
    table.kaarten td.acties button { padding:.5rem .9rem; font-size:.85rem; }
  }
</style>`;
