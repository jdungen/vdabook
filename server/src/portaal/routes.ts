import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import type pg from "pg";
import type { OAuthOpslag } from "../oauth-opslag.js";
import { cookieRegel, leesCookies, leesSessie, maakSessie, nieuwTotpSecret, otpauthUri, controleerTotp, Pogingen } from "../auth.js";
import { BEELDMERK_PNG, ICOON_PNG, WOORDMERK_PNG } from "../logo.js";
import { Gebruikers, MIN_WACHTWOORD, type Admin, type Gebruiker, type Rol } from "./gebruikers.js";
import { Rapport, LOON_TABEL, Aansluiting, type OnderlingPaar } from "./rapport.js";
type OnderlingRegel = OnderlingPaar["a"][number];
import { Audit, type Kolom } from "./audit.js";
import { Bank, Bankregels, type BankregelFilter } from "./bank.js";
import { adminNaam, bedragCel, datum, esc, euro, geleden, getal, kader, losKader, meldingen, qs, tijdstip } from "./ui.js";
import { datumInvoerNaarIso, datumVeld } from "./datumveld.js";

const here = dirname(fileURLToPath(import.meta.url));
const SESSIE_COOKIE = "vda_sessie";
const SESSIE_MS = 8 * 60 * 60_000;
const PAGINA = 100;

declare module "express-serve-static-core" {
  interface Request {
    g?: Gebruiker;
  }
}

export interface PortaalOpties {
  pool: pg.Pool;
  gebruikers: Gebruikers;
  sessieGeheim: string;
  publicUrl?: string;
  setupCode?: string;
  beheerderEmail?: string;
  /** Aanwezig als OAuth voor claude.ai aanstaat. */
  oauthOpslag?: OAuthOpslag | null;
}

const isHttps = (req: express.Request) => req.secure || req.header("x-forwarded-proto") === "https";
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};

function gelijk(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** CSV met puntkomma en komma-decimalen: opent zo direct goed in Nederlandse Excel. */
function csv(kolommen: Array<{ k: string; label: string }>, rijen: Array<Record<string, unknown>>): string {
  const cel = (v: unknown) => {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) {
      // Lokale tijd: pg levert date/timestamp als lokale tijd, toISOString zou er UTC van maken.
      const t = (n: number) => String(n).padStart(2, "0");
      const d = `${v.getFullYear()}-${t(v.getMonth() + 1)}-${t(v.getDate())}`;
      return v.getHours() || v.getMinutes() || v.getSeconds() ? `${d} ${t(v.getHours())}:${t(v.getMinutes())}:${t(v.getSeconds())}` : d;
    }
    if (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) && v.length < 16)) return String(v).replace(".", ",");
    if (typeof v === "object") return `"${JSON.stringify(v).replace(/"/g, '""')}"`;
    const s = String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [kolommen.map((k) => cel(k.label)).join(";"), ...rijen.map((r) => kolommen.map((k) => cel(r[k.k])).join(";"))].join("\r\n");
}

export function portaal(o: PortaalOpties): express.Router {
  const r = express.Router();
  const g = o.gebruikers;
  const rapport = new Rapport(o.pool);
  const audit = new Audit(o.pool);
  const bank = new Bank(o.pool);
  const bankregels = new Bankregels(o.pool);
  const aansluiting = new Aansluiting(o.pool);
  const pogingen = new Pogingen();
  setInterval(() => pogingen.opruimen(), 30 * 60_000).unref();

  r.use(express.urlencoded({ extended: false, limit: "64kb" }));

  /* ---------------------------------------------------------- beveiliging */

  r.use((req, res, next) => {
    res.set({
      "Content-Security-Policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cache-Control": "no-store",
    });
    if (isHttps(req)) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    // Elke POST moet van deze site komen (CSRF), naast SameSite=Lax op het cookie.
    if (req.method === "POST") {
      const origin = req.header("origin");
      const eigen = `${isHttps(req) ? "https" : "http"}://${req.header("host")}`;
      if (!origin || (origin !== eigen && origin !== o.publicUrl)) {
        res.status(403).type("text/plain").send("Verzoek van een onbekende herkomst geweigerd.");
        return;
      }
    }
    next();
  });

  // dd-mm-jjjj uit datumvelden → jjjj-mm-dd. Geen kalenderscript: deze app staat geen scripts toe (CSP).
  r.use(datumInvoerNaarIso(() => undefined));

  for (const [naam, png] of [["beeldmerk", BEELDMERK_PNG], ["woordmerk", WOORDMERK_PNG], ["icoon", ICOON_PNG]] as const) {
    r.get(`/logo/${naam}.png`, (_req, res) => res.set("Cache-Control", "public, max-age=86400").type("png").send(png));
  }
  r.get("/favicon.ico", (_req, res) => res.redirect(301, "/logo/icoon.png"));

  async function huidig(req: express.Request): Promise<Gebruiker | null> {
    const s = leesSessie(o.sessieGeheim, leesCookies(req.header("cookie"))[SESSIE_COOKIE]);
    if (!s) return null;
    const gb = await g.metId(s.uid);
    if (!gb || !gb.actief || gb.sessie_versie !== s.v) return null;
    return gb;
  }

  const zetSessie = (req: express.Request, res: express.Response, gb: Gebruiker) =>
    res.set("Set-Cookie", cookieRegel(SESSIE_COOKIE, maakSessie(o.sessieGeheim, gb.id, gb.sessie_versie, SESSIE_MS), { maxAge: SESSIE_MS / 1000, secure: isHttps(req) }));

  /** Alleen een pad binnen deze site als terugweg. */
  const veiligTerug = (t: unknown) => (typeof t === "string" && /^\/(?!\/)[\w\-./%?=&]*$/.test(t) ? t : "/");

  /* ------------------------------------------------------------- inloggen */

  const inlogPagina = (o2: { fout?: string; email?: string; terug?: string }) =>
    losKader(
      "Inloggen",
      `<h1>VDA Book</h1>
<p class="sub gedempt">Inzicht in de Exact Globe+-administraties. Alleen lezen.</p>
${o2.fout ? `<div class="bericht mis">${esc(o2.fout)}</div>` : ""}
<form method="post" action="/login${o2.terug ? `?terug=${encodeURIComponent(o2.terug)}` : ""}" autocomplete="on">
  <div><label for="e">E-mailadres</label><input id="e" name="email" type="email" required autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(o2.email ?? "")}" ${o2.email ? "" : "autofocus"}></div>
  <div><label for="w">Wachtwoord</label><input id="w" name="wachtwoord" type="password" required autocomplete="current-password" ${o2.email ? "autofocus" : ""}></div>
  <div><label for="c">Code uit je authenticator</label><input id="c" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" required autocomplete="one-time-code"></div>
  <button>Inloggen</button>
</form>`,
    );

  r.get("/login", async (req, res) => {
    if ((await g.aantalBeheerders()) === 0) return res.redirect("/setup");
    res.type("html").send(inlogPagina({ terug: str(req.query.terug) }));
  });

  r.post("/login", async (req, res) => {
    const ip = req.ip ?? "?";
    const terug = veiligTerug(req.query.terug);
    const email = String(req.body?.email ?? "").trim();
    const rem = pogingen.magProberen(ip);
    if (!rem.mag) {
      return res.status(429).type("html").send(inlogPagina({ fout: `Te veel mislukte pogingen. Probeer het over ${rem.wachtSeconden} seconden opnieuw.`, email, terug }));
    }
    const gb = await g.inloggen(email, String(req.body?.wachtwoord ?? ""), String(req.body?.code ?? ""));
    if (!gb) {
      pogingen.mislukt(ip);
      await g.log({ email, actie: "inloggen_mislukt", ip });
      return res.status(401).type("html").send(inlogPagina({ fout: "E-mailadres, wachtwoord of code klopt niet.", email, terug }));
    }
    pogingen.gelukt(ip);
    await g.log({ g: gb, actie: "inloggen", ip });
    zetSessie(req, res, gb);
    res.redirect(303, terug);
  });

  r.post("/uitloggen", async (req, res) => {
    const gb = await huidig(req);
    if (gb) {
      // Sessieversie ophogen: een bewaard of onderschept cookie werkt daarna niet meer.
      await g.intrekken(gb.id);
      await g.log({ g: gb, actie: "uitloggen", ip: req.ip });
    }
    res.set("Set-Cookie", cookieRegel(SESSIE_COOKIE, "", { maxAge: 0, secure: isHttps(req) })).redirect(303, "/login");
  });

  /* ---------------------------------------------------------------- setup */

  // Eerste beheerder. Alleen zolang er geen beheerder is, en alleen met de
  // setupcode uit de Railway-variabelen.
  r.get("/setup", async (_req, res) => {
    if ((await g.aantalBeheerders()) > 0) return res.redirect("/login");
    res.type("html").send(
      losKader(
        "Eerste beheerder",
        `<h1>Eerste beheerder</h1>
<p class="sub gedempt">Er is nog geen account. Vul de setupcode in uit Railway (VDA Book › vdabook › Variables › SETUP_CODE).</p>
${o.setupCode ? "" : `<div class="bericht mis">SETUP_CODE is niet ingesteld op de service.</div>`}
<form method="post" action="/setup">
  <div><label for="n">Naam</label><input id="n" name="naam" required value="Jan van den Dungen"></div>
  <div><label for="e">E-mailadres</label><input id="e" name="email" type="email" required value="${esc(o.beheerderEmail ?? "")}"></div>
  <div><label for="s">Setupcode</label><input id="s" name="setupcode" required autocomplete="off"></div>
  <button>Verder</button>
</form>`,
      ),
    );
  });

  r.post("/setup", async (req, res) => {
    if ((await g.aantalBeheerders()) > 0 || !o.setupCode) return res.redirect(303, "/login");
    const ip = req.ip ?? "?";
    if (!pogingen.magProberen(ip).mag) return res.status(429).send("Te veel pogingen.");
    if (!gelijk(String(req.body?.setupcode ?? "").trim(), o.setupCode)) {
      pogingen.mislukt(ip);
      return res.status(401).type("html").send(losKader("Eerste beheerder", `<div class="bericht mis">Setupcode klopt niet.</div><p><a href="/setup">Opnieuw</a></p>`));
    }
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const naam = String(req.body?.naam ?? "").trim() || email;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).send("Ongeldig e-mailadres.");
    const { code } = await g.uitnodigen({ email, naam, rol: "beheerder", lonen: true, admins: [] });
    await g.log({ email, actie: "setup_beheerder", ip });
    res.redirect(303, `/uitnodiging?t=${encodeURIComponent(code)}`);
  });

  /* ----------------------------------------------------------- uitnodiging */

  // Het TOTP-geheim reist tussen scherm en verzending als verborgen veld, met
  // een HMAC die het aan deze uitnodiging bindt. Zo hoeft het niet eerst
  // ongebruikt in de database, en kan niemand een eigen geheim inschuiven.
  const tekenGeheim = (code: string, geheim: string) => createHmac("sha256", o.sessieGeheim).update(`totp|${code}|${geheim}`).digest("base64url");

  async function uitnodigingPagina(code: string, gb: Gebruiker, geheim: string, fout?: string) {
    const uri = otpauthUri(geheim, gb.email, "VDA Book");
    const qr = await QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return losKader(
      "Account activeren",
      `<h1>Welkom, ${esc(gb.naam)}</h1>
<p class="sub gedempt">Je bent uitgenodigd als <strong>${esc(gb.rol)}</strong> voor VDA Book. Kies een wachtwoord en koppel een authenticator-app (Microsoft Authenticator, Google Authenticator, Keeper, 1Password).</p>
${fout ? `<div class="bericht mis">${esc(fout)}</div>` : ""}
<form method="post" action="/uitnodiging">
  <input type="hidden" name="t" value="${esc(code)}">
  <input type="hidden" name="geheim" value="${esc(geheim)}">
  <input type="hidden" name="teken" value="${esc(tekenGeheim(code, geheim))}">
  <div><label>E-mailadres</label><input type="email" name="email" value="${esc(gb.email)}" autocomplete="username" readonly></div>
  <div><label for="w">Wachtwoord (minstens ${MIN_WACHTWOORD} tekens)</label><input id="w" name="wachtwoord" type="password" minlength="${MIN_WACHTWOORD}" required autocomplete="new-password"></div>
  <div><label for="w2">Nog een keer</label><input id="w2" name="wachtwoord2" type="password" minlength="${MIN_WACHTWOORD}" required autocomplete="new-password"></div>
  <div><label>Scan met je authenticator</label><div class="qr">${qr}</div><p class="geheim">${esc(geheim.replace(/(.{4})/g, "$1 ").trim())}</p></div>
  <div><label for="c">Code die de app nu toont</label><input id="c" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" required autocomplete="one-time-code"></div>
  <button>Account activeren</button>
</form>`,
    );
  }

  r.get("/uitnodiging", async (req, res) => {
    const code = str(req.query.t) ?? "";
    const gb = code ? await g.uitnodigingLezen(code) : null;
    if (!gb) return res.status(400).type("html").send(losKader("Uitnodiging", `<div class="bericht mis">Deze uitnodiging is onbekend, verlopen of al gebruikt. Vraag een nieuwe aan.</div>`));
    res.type("html").send(await uitnodigingPagina(code, gb, nieuwTotpSecret()));
  });

  r.post("/uitnodiging", async (req, res) => {
    const code = String(req.body?.t ?? "");
    const geheim = String(req.body?.geheim ?? "");
    const gb = code ? await g.uitnodigingLezen(code) : null;
    if (!gb) return res.status(400).type("html").send(losKader("Uitnodiging", `<div class="bericht mis">Deze uitnodiging is onbekend, verlopen of al gebruikt.</div>`));
    if (!gelijk(String(req.body?.teken ?? ""), tekenGeheim(code, geheim))) return res.status(400).send("Ongeldig formulier.");
    const ww = String(req.body?.wachtwoord ?? "");
    if (ww.length < MIN_WACHTWOORD) return res.type("html").send(await uitnodigingPagina(code, gb, geheim, `Het wachtwoord moet minstens ${MIN_WACHTWOORD} tekens hebben.`));
    if (ww !== String(req.body?.wachtwoord2 ?? "")) return res.type("html").send(await uitnodigingPagina(code, gb, geheim, "De twee wachtwoorden zijn niet gelijk."));
    if (!controleerTotp(geheim, String(req.body?.code ?? ""))) {
      return res.type("html").send(await uitnodigingPagina(code, gb, geheim, "Die code klopt niet. Controleer of de klok van je telefoon goed staat en probeer de volgende code."));
    }
    const actief = await g.activeren(code, ww, geheim);
    if (!actief) return res.status(409).send("Uitnodiging intussen gebruikt.");
    await g.log({ g: actief, actie: "account_geactiveerd", ip: req.ip });
    zetSessie(req, res, actief);
    res.redirect(303, "/");
  });

  /* --------------------------------------------------------------- inlog-eis */

  r.use(async (req, res, next) => {
    const gb = await huidig(req);
    if (!gb) {
      if (req.method === "GET") return res.redirect(`/login?terug=${encodeURIComponent(req.originalUrl)}`);
      return res.status(401).send("Niet ingelogd.");
    }
    req.g = gb;
    next();
  });

  /* --------------------------------------------- OAuth-toestemming (Claude) */

  // claude.ai stuurt de browser hierheen. Alleen een ingelogde beheerder kan
  // toestemming geven, en alleen met een verse code uit de authenticator.
  if (o.oauthOpslag) {
    const opslag = o.oauthOpslag;
    const pagina = (gb: Gebruiker, verzoek: string, client: string, host: string, melding?: string) =>
      losKader(
        "Claude koppelen",
        `<h1>Claude koppelen</h1>
<p class="sub gedempt"><strong>${esc(client)}</strong> vraagt leestoegang tot alle administraties in VDA Book, namens ${esc(gb.naam)}. Na toestemming gaat de browser terug naar <span class="mono">${esc(host)}</span>.</p>
${melding ? `<div class="bericht mis">${esc(melding)}</div>` : ""}
<form method="post" action="/oauth/toestemming">
  <input type="hidden" name="verzoek" value="${esc(verzoek)}">
  <div><label for="c">Bevestig met een code uit je authenticator</label><input id="c" name="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code"></div>
  <button name="besluit" value="toestaan">Toestaan</button>
  <button name="besluit" value="weigeren" formnovalidate style="background:transparent;color:var(--inkt);border-color:var(--lijn)">Weigeren</button>
</form>`,
      );
    r.get("/oauth/toestemming", async (req, res) => {
      if (req.g!.rol !== "beheerder") return res.status(403).type("html").send(losKader("Claude koppelen", `<div class="bericht mis">Alleen de beheerder kan Claude koppelen.</div>`));
      const id = str(req.query.verzoek) ?? "";
      const v = id ? await opslag.verzoekLezen(id) : null;
      if (!v) return res.status(400).type("html").send(losKader("Claude koppelen", `<div class="bericht mis">Dit koppelverzoek is onbekend, verlopen of al afgehandeld. Start de koppeling opnieuw vanuit Claude.</div>`));
      res.type("html").send(pagina(req.g!, id, v.clientNaam, new URL(v.redirectUri).host));
    });
    r.post("/oauth/toestemming", async (req, res) => {
      if (req.g!.rol !== "beheerder") return res.status(403).send("Alleen de beheerder.");
      const id = String(req.body?.verzoek ?? "");
      const v = id ? await opslag.verzoekLezen(id) : null;
      if (!v) return res.status(400).type("html").send(losKader("Claude koppelen", `<div class="bericht mis">Dit koppelverzoek is onbekend, verlopen of al afgehandeld.</div>`));
      if (req.body?.besluit === "weigeren") {
        await opslag.verzoekBesluiten(id, "geweigerd");
        await log(req, "oauth_geweigerd", null, { client: v.clientNaam });
        return res.redirect(303, `/oauth/terug?verzoek=${encodeURIComponent(id)}`);
      }
      const ip = req.ip ?? "?";
      if (!pogingen.magProberen(ip).mag) return res.status(429).type("html").send(pagina(req.g!, id, v.clientNaam, new URL(v.redirectUri).host, "Te veel mislukte pogingen. Probeer het later opnieuw."));
      if (!(await g.totpKlopt(req.g!.id, String(req.body?.code ?? "")))) {
        pogingen.mislukt(ip);
        return res.status(401).type("html").send(pagina(req.g!, id, v.clientNaam, new URL(v.redirectUri).host, "Die code klopt niet."));
      }
      pogingen.gelukt(ip);
      if (!(await opslag.verzoekBesluiten(id, "goedgekeurd"))) return res.status(409).send("Verzoek intussen verlopen of afgehandeld.");
      await log(req, "oauth_toegestaan", null, { client: v.clientNaam, clientId: v.clientId });
      res.redirect(303, `/oauth/terug?verzoek=${encodeURIComponent(id)}`);
    });
  }

  const fout = (res: express.Response, status: number, gb: Gebruiker, admins: Admin[], melding: string) =>
    res.status(status).type("html").send(kader({ titel: "Fout", g: gb, admins }, `<div class="bericht mis">${esc(melding)}</div>`));

  /** Administratie uit het pad, alleen als deze gebruiker hem mag zien. */
  async function adminUit(req: express.Request, res: express.Response): Promise<{ a: Admin; admins: Admin[] } | null> {
    const admins = await g.admins(req.g!);
    const a = admins.find((x) => x.slug === req.params.db);
    if (!a) {
      fout(res, 404, req.g!, admins, "Deze administratie bestaat niet of je hebt er geen toegang toe.");
      return null;
    }
    return { a, admins };
  }

  const log = (req: express.Request, actie: string, admin?: string | null, detail?: unknown) =>
    g.log({ g: req.g, actie, admin: admin ?? null, pad: req.originalUrl.slice(0, 500), ip: req.ip, detail });

  async function jaarUit(req: express.Request, admin: string): Promise<{ jaar: number; jaren: number[] }> {
    const jaren = await rapport.boekjaren(admin);
    const gevraagd = int(req.query.jaar);
    const jaar = gevraagd && jaren.includes(gevraagd) ? gevraagd : (jaren[0] ?? new Date().getFullYear());
    return { jaar, jaren };
  }

  const jaarKiezer = (jaren: number[], jaar: number, extra = "") =>
    `<label>Boekjaar<select name="jaar">${jaren.map((j) => `<option${j === jaar ? " selected" : ""}>${j}</option>`).join("")}</select></label>${extra}`;

  const boekstukLink = (db: string, dagboek: unknown, boekstuk: unknown) =>
    dagboek && boekstuk
      ? `<a class="mono" href="/a/${encodeURIComponent(db)}/boekstuk/${encodeURIComponent(String(dagboek))}/${encodeURIComponent(String(boekstuk))}">${esc(dagboek)}·${esc(boekstuk)}</a>`
      : esc(boekstuk ?? "");
  const rekLink = (db: string, rek: unknown, jaar?: number) =>
    rek ? `<a class="mono" href="/a/${encodeURIComponent(db)}/grootboek/${encodeURIComponent(String(rek))}${jaar ? `?jaar=${jaar}` : ""}">${esc(rek)}</a>` : "";

  /* ------------------------------------------------------- startoverzicht */

  r.get("/", async (req, res) => {
    const admins = await g.admins(req.g!);
    if (admins.length === 1) return res.redirect(`/a/${encodeURIComponent(admins[0]!.slug)}/`);
    const tegels: string[] = [];
    for (const a of admins) {
      const jaren = await rapport.boekjaren(a.admin_key);
      const jaar = jaren[0];
      const k = jaar ? await rapport.kerncijfers(a.admin_key, jaar) : null;
      const res2 = Number(k?.resultaat ?? 0);
      tegels.push(`<a class="tegel groot" href="/a/${encodeURIComponent(a.slug)}/">
        <div class="titel">${esc(adminNaam(a))}</div>
        <div class="noot">Administratie ${esc(a.database_name)} · bijgewerkt ${esc(geleden(a.laatst_sync))}</div>
        ${jaar ? `<div class="label" style="margin-top:.8rem">Resultaat ${jaar} tot nu</div><div class="waarde ${res2 < 0 ? "neg" : ""}">${euro(res2)}</div>` : `<div class="noot">Nog geen boekingen in de spiegel.</div>`}
      </a>`);
    }
    await log(req, "bekijk_start");
    res.type("html").send(
      kader(
        { titel: "Overzicht", g: req.g!, admins },
        `<header class="top"><div><h1>Administraties</h1><p class="sub">Exact Globe+ · alleen lezen · ingelogd als ${esc(req.g!.naam)} (${esc(req.g!.rol)})</p></div></header>
${admins.length > 1 ? `<p><a class="knop" href="/onderling">Onderlinge verhoudingen tussen de administraties</a></p>` : ""}
${admins.length === 0 ? `<div class="leeg">${req.g!.rol === "beheerder" ? "Nog geen administraties. Zodra de agent op de Globe-pc zijn eerste run heeft gedaan, staan ze hier. Zie <a href=\"/beheer/sync\">Beheer › Synchronisatie</a>." : "Je hebt nog geen toegang tot een administratie. Vraag de beheerder."}</div>` : `<div class="tegels">${tegels.join("")}</div>`}`,
      ),
    );
  });

  /* ------------------------------------------------ onderlinge verhoudingen */

  r.get("/onderling", async (req, res) => {
    const admins = await g.admins(req.g!);
    const jaren = Array.from(new Set((await Promise.all(admins.map((a) => rapport.boekjaren(a.admin_key)))).flat())).sort((x, y) => y - x);
    const jaar = int(req.query.jaar) && jaren.includes(int(req.query.jaar)!) ? int(req.query.jaar)! : (jaren[0] ?? new Date().getFullYear());
    const paren = await aansluiting.onderling(admins, jaar);
    await log(req, "bekijk_onderling", null, { jaar });
    const kant = (rijen: OnderlingRegel[], som: number, ref: number | null, naam: string) =>
      `<div class="kaart schuif"><table class="lijst"><tr class="kop"><td colspan="3">${esc(naam)}</td></tr>${
        rijen.length
          ? rijen.map((x) => `<tr><td class="mono">${esc(x.rekening)}</td><td>${esc(x.omschrijving)}</td>${bedragCel(x.saldo)}</tr>`).join("")
          : `<tr><td colspan="3" class="gedempt">Geen rekening gevonden met de naam van de andere partij.</td></tr>`
      }<tr class="totaal"><td colspan="2">Saldo in Globe (+ vordering, − schuld)</td>${bedragCel(som)}</tr>${
        ref !== null ? `<tr><td colspan="2" class="gedempt">Volgens de jaarrekening</td>${bedragCel(ref)}</tr>` : ""
      }</table></div>`;
    res.type("html").send(
      kader(
        { titel: "Onderlinge verhoudingen", g: req.g!, admins },
        `<header class="top"><div><h1>Onderlinge verhoudingen</h1><p class="sub">Rekening-courant en andere posities tussen de administraties, eind ${jaar}</p></div>
<form class="filter" method="get"><label>Boekjaar<select name="jaar">${jaren.map((j) => `<option${j === jaar ? " selected" : ""}>${j}</option>`).join("")}</select></label><button>Toon</button></form></header>
<p class="uitleg">Wat de ene administratie van de andere te vorderen heeft, hoort de andere precies als schuld te tonen. Samen moeten ze op nul uitkomen. Rekeningen worden herkend aan de naam van de andere partij (bijv. "R/C Drie D Holding"). Vergelijking met de jaarrekening waar die is ingelezen.</p>
${paren.length === 0 ? `<div class="leeg">Nog geen onderlinge posities gevonden${admins.length < 2 ? " — je hebt toegang tot maar één administratie" : ""}.</div>` : paren
          .map((p) => {
            const refVerschil = p.refA !== null && p.refB !== null ? Math.round((p.refA + p.refB) * 100) / 100 : null;
            return `<h2>${esc(p.naamA)} ↔ ${esc(p.naamB)}</h2>
<div class="tegels" style="grid-template-columns:repeat(auto-fit,minmax(22rem,1fr))">${kant(p.a, p.somA, p.refA, p.naamA)}${kant(p.b, p.somB, p.refB, p.naamB)}</div>
<p>${p.a.length || p.b.length ? (Math.abs(p.verschil) < 1 ? `<span class="badge ok">Globe sluit</span>` : `<span class="badge let">Globe sluit niet: ${euro(p.verschil)}</span>`) : ""} ${refVerschil === null ? "" : Math.abs(refVerschil) < 1 ? `<span class="badge ok">jaarrekeningen sluiten</span>` : `<span class="badge mis">jaarrekeningen sluiten niet: ${euro(refVerschil)}</span>`}</p>`;
          })
          .join("")}`,
      ),
    );
  });

  /* ------------------------------------------------- overzicht per admin */

    r.get("/a/:db/", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const { jaar, jaren } = await jaarUit(req, a.admin_key);
    const k = await rapport.kerncijfers(a.admin_key, jaar);
    const vorig = jaren.includes(jaar - 1) ? await rapport.kerncijfers(a.admin_key, jaar - 1) : null;
    const recent = await rapport.recent(a.admin_key, 30, req.g!.lonen);
    const wie = await rapport.gebruikers(a.admin_key, jaar);
    const ans = await aansluiting.regels(a.admin_key, a.bedrijfsnaam, jaar);
    const db = a.slug;
    const liq = (k.liquide as Array<{ grootboek: string; oms: string; saldo: string }>).reduce((t, x) => t + Number(x.saldo), 0);

    const tegel = (label: string, waarde: unknown, noot = "", klasse = "") =>
      `<div class="tegel"><div class="label">${esc(label)}</div><div class="waarde ${klasse}">${waarde}</div>${noot ? `<div class="noot">${noot}</div>` : ""}</div>`;
    const resNu = Number(k.resultaat ?? 0);
    const verschilNoot = vorig ? `${jaar - 1}: ${euro(vorig.resultaat ?? 0)} (heel jaar)` : "";

    const nieuwRijen = recent.nieuw
      .map(
        (n: any) =>
          `<tr><td>${datum(n.dag)}</td><td>${esc(n.dagboek)}</td><td class="r num">${getal(n.boekstukken)}</td><td class="r num">${getal(n.regels)}</td>${bedragCel(n.omvang)}<td><a href="/a/${encodeURIComponent(db)}/mutaties${qs({ dagboek: n.dagboek, van: String(n.dag).slice(0, 10) })}">bekijk</a></td></tr>`,
      )
      .join("");
    const wijzRijen = recent.wijzigingen
      .map((w: any) => `<tr><td class="mono">${esc(w.tbl)}</td><td><span class="badge ${w.soort === "verwijderd" ? "mis" : "let"}">${esc(w.soort)}</span></td><td class="r num">${getal(w.n)}</td><td>${tijdstip(w.laatst)}</td></tr>`)
      .join("");

    await log(req, "bekijk_overzicht", a.admin_key);
    res.type("html").send(
      kader(
        { titel: adminNaam(a), g: req.g!, admins, admin: a, actief: "overzicht", subpad: "/" },
        `<header class="top"><div><h1>${esc(adminNaam(a))}</h1><p class="sub">Administratie ${esc(db)} · spiegel bijgewerkt ${esc(geleden(a.laatst_sync))} (${tijdstip(a.laatst_sync)})</p></div>
<form class="filter" method="get">${jaarKiezer(jaren, jaar)}<button>Toon</button></form></header>
${a.laatst_sync && Date.now() - new Date(a.laatst_sync).getTime() > 3 * 86400_000 ? `<div class="bericht let">De laatste sync is meer dan drie dagen oud. De pc bij Van Dungen Automaten staat vermoedelijk uit; wat hier staat is de stand van ${tijdstip(a.laatst_sync)}.</div>` : ""}
<div class="tegels">
  ${tegel(`Resultaat ${jaar}`, euro(resNu), verschilNoot, resNu < 0 ? "neg" : "pos")}
  ${tegel("Opbrengsten", euro(k.opbrengsten ?? 0))}
  ${tegel("Kosten", euro(k.kosten ?? 0))}
  ${tegel("Liquide middelen eind " + jaar, euro(liq), (k.liquide as any[]).map((x) => `${esc(x.oms)}: ${euro(x.saldo)}`).join("<br>") || "geen bank- of kasrekening herkend")}
  ${tegel("Boekstukken", getal(k.boekstukken), `${getal(k.regels)} regels · laatste boekdatum ${datum(k.laatste_datum)}`)}
</div>
${ans.regels.length ? `<h2>Aansluiting met de jaarrekening ${jaar}</h2>
<p class="uitleg">Cijfers uit de spiegel naast die uit ${esc(ans.bron ?? "de jaarrekening")}. Een verschil is geen fout op zich: de accountant boekt vaak correcties buiten Globe. Het laat zien wat er tussen de boekhouding en de jaarrekening gebeurt.</p>
<div class="kaart schuif"><table class="lijst"><tr><th>Post</th><th class="r">Spiegel (Globe)</th><th class="r">Jaarrekening</th><th class="r">Verschil</th><th>Toelichting</th></tr>${ans.regels
          .map((x) => `<tr><td>${esc(x.label)}</td>${bedragCel(x.spiegel)}${bedragCel(x.jaarrekening)}<td class="r num">${x.verschil === null ? "" : Math.abs(x.verschil) < 1 ? `<span class="badge ok">sluit</span>` : `<span class="badge let">${euro(x.verschil)}</span>`}</td><td class="gedempt" style="font-size:.8rem;max-width:28rem">${esc(x.noot)}</td></tr>`)
          .join("")}</table></div>` : ""}
<h2>Wat er de afgelopen 30 dagen is geboekt</h2>
<p class="uitleg">Nieuw in de spiegel sinds de eerste volledige sync, per dag en dagboek.</p>
${nieuwRijen ? `<div class="kaart schuif"><table class="lijst"><tr><th>Gezien</th><th>Dagboek</th><th class="r">Boekstukken</th><th class="r">Regels</th><th class="r">Omvang</th><th></th></tr>${nieuwRijen}</table></div>` : `<div class="leeg">Geen nieuwe boekingen gezien in de afgelopen 30 dagen.</div>`}
<h2>Achteraf gewijzigd of verwijderd (30 dagen)</h2>
${wijzRijen ? `<div class="kaart schuif"><table class="lijst"><tr><th>Tabel</th><th>Soort</th><th class="r">Aantal</th><th>Laatst</th></tr>${wijzRijen}</table></div><p><a href="/a/${encodeURIComponent(db)}/wijzigingen">Alle wijzigingen bekijken</a></p>` : `<div class="leeg">Niets gewijzigd of verwijderd na boeking.</div>`}
<h2>Wie boekt in ${jaar}</h2>
<p class="uitleg">De Globe-gebruiker die de regels heeft ingevoerd.</p>
${wie.length ? `<div class="kaart schuif"><table class="lijst"><tr><th>Gebruiker</th><th class="r">Boekstukken</th><th class="r">Regels</th><th>Eerste</th><th>Laatste</th><th></th></tr>${wie
          .map((w: any) => `<tr><td>${esc(w.naam ?? w.gebruiker ?? "onbekend")} <span class="gedempt mono">${esc(w.gebruiker ?? "")}</span></td><td class="r num">${getal(w.boekstukken)}</td><td class="r num">${getal(w.regels)}</td><td>${datum(w.eerste)}</td><td>${datum(w.laatste)}</td><td>${w.gebruiker ? `<a href="/a/${encodeURIComponent(db)}/mutaties${qs({ gebruiker: w.gebruiker, jaar })}">bekijk</a>` : ""}</td></tr>`)
          .join("")}</table></div>` : `<div class="leeg">Geen gegevens.</div>`}`,
      ),
    );
  });

  /* --------------------------------------------------------------- balans */

  r.get("/a/:db/balans", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const { jaar, jaren } = await jaarUit(req, a.admin_key);
    const per = Math.min(Math.max(int(req.query.periode) ?? 99, 0), 99);
    const b = await rapport.balans(a.admin_key, jaar, per);
    const db = a.slug;
    const balans = b.rijen.filter((x: any) => (x.bal_vw ?? "B") === "B" && (Math.abs(Number(x.saldo ?? 0)) > 0.004 || Math.abs(Number(x.vorig ?? 0)) > 0.004));
    const wv = b.rijen.filter((x: any) => x.bal_vw === "W");
    // Zelfde selectie als de balansrekeningen (jaar, periode, methode): dan sluit het per definitie.
    const resultaat = -wv.reduce((t: number, x: any) => t + Number(x.saldo ?? 0), 0);
    const debet = balans.filter((x: any) => Number(x.saldo) > 0);
    const credit = balans.filter((x: any) => Number(x.saldo) < 0);
    const som = (l: any[], k = "saldo") => l.reduce((t, x) => t + Number(x[k] ?? 0), 0);
    const rij = (x: any) =>
      `<tr><td>${rekLink(db, x.grootboek, jaar)}</td><td>${esc(x.omschrijving ?? "")}</td>${bedragCel(Math.abs(Number(x.saldo ?? 0)))}${bedragCel(x.vorig === null ? null : Math.abs(Number(x.vorig)))}</tr>`;
    const controle = som(balans) - resultaat;
    const resLabel = b.methode === "beginbalans" ? "Resultaat lopend boekjaar" : "Resultaat (nog niet verdeeld, alle jaren tot en met dit jaar)";

    await log(req, "bekijk_balans", a.admin_key, { jaar, per });
    res.type("html").send(
      kader(
        { titel: "Balans", g: req.g!, admins, admin: a, actief: "balans", subpad: "/balans" },
        `<header class="top"><div><h1>Balans</h1><p class="sub">${esc(adminNaam(a))} · eind ${per >= 99 ? "boekjaar" : `periode ${per}`} ${jaar}</p></div>
<form class="filter" method="get">${jaarKiezer(jaren, jaar)}<label>Tot en met periode<select name="periode">${[99, ...Array.from({ length: 13 }, (_, i) => i)].map((p) => `<option value="${p}"${p === per ? " selected" : ""}>${p === 99 ? "einde jaar" : p}</option>`).join("")}</select></label><button>Toon</button></form></header>
<p class="uitleg">${b.methode === "beginbalans" ? "Beginbalans uit periode 0 van het boekjaar." : "Geen beginbalans in periode 0 gevonden; saldi zijn opgeteld over alle jaren tot en met dit boekjaar."} Bedragen als absolute waarde per kant; vergelijking met eind vorig boekjaar.</p>
<div class="tegels" style="grid-template-columns:repeat(auto-fit,minmax(22rem,1fr))">
<div class="kaart schuif"><table class="lijst"><tr class="kop"><td colspan="4">Debet (activa)</td></tr><tr><th>Rek.</th><th>Omschrijving</th><th class="r">${jaar}</th><th class="r">${jaar - 1}</th></tr>${debet.map(rij).join("")}
<tr class="totaal"><td colspan="2">Totaal</td>${bedragCel(som(debet))}<td></td></tr></table></div>
<div class="kaart schuif"><table class="lijst"><tr class="kop"><td colspan="4">Credit (passiva)</td></tr><tr><th>Rek.</th><th>Omschrijving</th><th class="r">${jaar}</th><th class="r">${jaar - 1}</th></tr>${credit.map(rij).join("")}
<tr><td></td><td>${esc(resLabel)}</td>${bedragCel(resultaat)}<td></td></tr>
<tr class="totaal"><td colspan="2">Totaal</td>${bedragCel(-som(credit) + resultaat)}<td></td></tr></table></div>
</div>
${Math.abs(controle) > 0.01 ? `<div class="bericht let">Debet en credit sluiten niet: verschil ${euro(controle)}. Zie Audit › Boekstukken die niet in balans zijn.</div>` : `<div class="bericht ok">Debet en credit sluiten.</div>`}`,
      ),
    );
  });

  /* ------------------------------------------------------------ resultaat */

  r.get("/a/:db/resultaat", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const { jaar, jaren } = await jaarUit(req, a.admin_key);
    const w = await rapport.resultaat(a.admin_key, jaar);
    const db = a.slug;
    const per = w.perioden;
    const totPer: Record<number, number> = {};
    let tot = 0;
    let totVorig = 0;
    const rijen = w.rijen
      .filter((x: any) => Math.abs(Number(x.totaal ?? 0)) > 0.004 || Math.abs(Number(x.vorig ?? 0)) > 0.004)
      .map((x: any) => {
        tot += Number(x.totaal ?? 0);
        totVorig += Number(x.vorig ?? 0);
        const cellen = per
          .map((p) => {
            const v = x.per_periode?.[String(p)];
            totPer[p] = (totPer[p] ?? 0) + Number(v ?? 0);
            return v === undefined ? `<td></td>` : bedragCel(v);
          })
          .join("");
        return `<tr><td>${rekLink(db, x.grootboek, jaar)}</td><td>${esc(x.omschrijving ?? "")}</td>${cellen}${bedragCel(x.totaal)}${bedragCel(x.vorig)}</tr>`;
      })
      .join("");

    if (req.query.formaat === "csv") {
      await log(req, "export_resultaat", a.admin_key, { jaar });
      const kol = [{ k: "grootboek", label: "Rekening" }, { k: "omschrijving", label: "Omschrijving" }, ...per.map((p) => ({ k: `p${p}`, label: `Periode ${p}` })), { k: "totaal", label: `Totaal ${jaar}` }, { k: "vorig", label: `Totaal ${jaar - 1}` }];
      const data = w.rijen.map((x: any) => ({ ...x, ...Object.fromEntries(per.map((p) => [`p${p}`, x.per_periode?.[String(p)] ?? null])) }));
      return res.type("text/csv; charset=utf-8").attachment(`resultaat-${db}-${jaar}.csv`).send(csv(kol, data));
    }

    await log(req, "bekijk_resultaat", a.admin_key, { jaar });
    res.type("html").send(
      kader(
        { titel: "Resultaat", g: req.g!, admins, admin: a, actief: "resultaat", subpad: "/resultaat" },
        `<header class="top"><div><h1>Winst-en-verliesrekening</h1><p class="sub">${esc(adminNaam(a))} · ${jaar} per periode · opbrengst positief, kosten negatief</p></div>
<form class="filter" method="get">${jaarKiezer(jaren, jaar)}<button>Toon</button><a class="knop" href="${qs({ jaar, formaat: "csv" })}">CSV</a></form></header>
<div class="kaart schuif"><table class="lijst"><tr><th>Rek.</th><th>Omschrijving</th>${per.map((p) => `<th class="r">${p}</th>`).join("")}<th class="r">${jaar}</th><th class="r">${jaar - 1}</th></tr>
${rijen}
<tr class="totaal"><td colspan="2">Resultaat</td>${per.map((p) => bedragCel(totPer[p] ?? 0)).join("")}${bedragCel(tot)}${bedragCel(totVorig)}</tr></table></div>`,
      ),
    );
  });

  /* ------------------------------------------------- mutaties / grootboek */

  r.get("/a/:db/mutaties", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const jaren = await rapport.boekjaren(a.admin_key);
    const f = {
      grootboek: str(req.query.grootboek),
      relatie: str(req.query.relatie),
      zoek: str(req.query.zoek),
      van: str(req.query.van)?.match(/^\d{4}-\d{2}-\d{2}$/) ? str(req.query.van) : undefined,
      tot: str(req.query.tot)?.match(/^\d{4}-\d{2}-\d{2}$/) ? str(req.query.tot) : undefined,
      jaar: int(req.query.jaar),
      dagboek: str(req.query.dagboek),
      gebruiker: str(req.query.gebruiker),
    };
    const csvExport = req.query.formaat === "csv";
    const pagina = Math.max(int(req.query.p) ?? 0, 0);
    const m = await rapport.mutaties(a.admin_key, f, req.g!.lonen, csvExport ? 100_000 : PAGINA, csvExport ? 0 : pagina * PAGINA);
    if (csvExport) {
      await log(req, "export_mutaties", a.admin_key, f);
      const kol = ["boekjaar", "periode", "datum", "dagboek", "boekstuk", "grootboek", "rekening", "omschrijving", "bedrag", "debiteur", "crediteur", "factuurnr", "kostenplaats", "btw_code", "gebruiker"].map((k) => ({ k, label: k }));
      return res.type("text/csv; charset=utf-8").attachment(`mutaties-${db}.csv`).send(csv(kol, m.rijen));
    }
    await log(req, "bekijk_mutaties", a.admin_key, f);
    const rijen = m.rijen
      .map(
        (x: any) =>
          `<tr><td>${datum(x.datum)}</td><td>${boekstukLink(db, x.dagboek, x.boekstuk)}</td><td>${rekLink(db, x.grootboek, x.boekjaar)} <span class="gedempt">${esc(x.rekening ?? "")}</span></td><td>${esc(x.omschrijving ?? "")}</td><td class="mono">${esc(x.debiteur ?? x.crediteur ?? "")}</td><td class="mono">${esc(x.factuurnr ?? "")}</td>${bedragCel(x.bedrag)}</tr>`,
      )
      .join("");
    res.type("html").send(
      kader(
        { titel: "Mutaties", g: req.g!, admins, admin: a, actief: "mutaties", subpad: "/mutaties" },
        `<header class="top"><div><h1>Mutaties</h1><p class="sub">${esc(adminNaam(a))} · ${getal(m.aantal)} regels · saldo ${euro(m.som)}</p></div></header>
<form class="filter" method="get">
  <label>Zoek<input name="zoek" value="${esc(f.zoek ?? "")}" placeholder="omschrijving, factuur, boekstuk"></label>
  <label>Rekening<input name="grootboek" value="${esc(f.grootboek ?? "")}" size="8"></label>
  <label>Relatie<input name="relatie" value="${esc(f.relatie ?? "")}" size="8"></label>
  <label>Dagboek<input name="dagboek" value="${esc(f.dagboek ?? "")}" size="4"></label>
  <label>Boekjaar<select name="jaar"><option value="">alle</option>${jaren.map((j) => `<option${j === f.jaar ? " selected" : ""}>${j}</option>`).join("")}</select></label>
  <label>Van${datumVeld("van", f.van)}</label>
  <label>Tot${datumVeld("tot", f.tot)}</label>
  ${f.gebruiker ? `<input type="hidden" name="gebruiker" value="${esc(f.gebruiker)}">` : ""}
  <button class="primair">Zoek</button><a class="knop" href="${qs({ ...f, formaat: "csv" })}">CSV</a>
</form>
${req.g!.lonen ? "" : `<p class="uitleg">Regels op loon- en personeelsrekeningen zijn voor jouw account verborgen.</p>`}
${rijen ? `<div class="kaart schuif"><table class="lijst"><tr><th>Datum</th><th>Boekstuk</th><th>Rekening</th><th>Omschrijving</th><th>Relatie</th><th>Factuur</th><th class="r">Bedrag</th></tr>${rijen}</table></div>` : `<div class="leeg">Geen mutaties met deze filters.</div>`}
<div class="paginering"><span>${m.aantal > PAGINA ? `Regels ${pagina * PAGINA + 1}–${Math.min((pagina + 1) * PAGINA, m.aantal)} van ${getal(m.aantal)}` : ""}</span><span class="knoppen">${pagina > 0 ? `<a class="knop" href="${qs({ ...f, p: pagina - 1 })}">Vorige</a>` : ""}${(pagina + 1) * PAGINA < m.aantal ? `<a class="knop" href="${qs({ ...f, p: pagina + 1 })}">Volgende</a>` : ""}</span></div>`,
      ),
    );
  });

  r.get("/a/:db/grootboek/:rek", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const rek = req.params.rek!;
    const { jaar, jaren } = await jaarUit(req, a.admin_key);
    const info = (await rapport.rekeningen(a.admin_key)).get(rek);
    const verborgen = !req.g!.lonen && new RegExp((await import("./rapport.js")).LOON_REKENING, "i").test(info?.omschrijving ?? "");
    const k = verborgen ? { beginsaldo: 0, rijen: [] } : await rapport.grootboekkaart(a.admin_key, rek, jaar, req.g!.lonen);
    await log(req, "bekijk_grootboek", a.admin_key, { rek, jaar });
    const eind = k.rijen.length ? Number((k.rijen[k.rijen.length - 1] as any).lopend) + k.beginsaldo : k.beginsaldo;
    res.type("html").send(
      kader(
        { titel: `Rekening ${rek}`, g: req.g!, admins, admin: a, actief: "mutaties", subpad: `/grootboek/${encodeURIComponent(rek)}` },
        `<header class="top"><div><h1>${esc(rek)} ${esc(info?.omschrijving ?? "")}</h1><p class="sub">${esc(adminNaam(a))} · ${info?.bal_vw === "W" ? "winst-en-verlies" : "balans"} · ${jaar}</p></div>
<form class="filter" method="get">${jaarKiezer(jaren, jaar)}<button>Toon</button><a class="knop" href="/a/${encodeURIComponent(db)}/mutaties${qs({ grootboek: rek, jaar, formaat: "csv" })}">CSV</a></form></header>
${verborgen ? `<div class="bericht let">Dit is een loon- of personeelsrekening. De regels zijn voor jouw account verborgen; het saldo staat in balans en resultaat.</div>` : `
<div class="kaart schuif"><table class="lijst"><tr><th>Datum</th><th>Boekstuk</th><th>Omschrijving</th><th>Relatie</th><th class="r">Bedrag</th><th class="r">Saldo</th></tr>
<tr class="kop"><td colspan="5">Beginsaldo</td>${bedragCel(k.beginsaldo)}</tr>
${(k.rijen as any[]).map((x) => `<tr><td>${datum(x.datum)}</td><td>${x.samengevat ? `<span class="gedempt">periode ${esc(x.periode)}</span>` : boekstukLink(db, x.dagboek, x.boekstuk)}</td><td${x.samengevat ? ' class="gedempt"' : ""}>${esc(x.omschrijving ?? "")}</td><td class="mono">${esc(x.debiteur ?? x.crediteur ?? "")}</td>${bedragCel(x.bedrag)}${bedragCel(Number(x.lopend) + k.beginsaldo)}</tr>`).join("")}
<tr class="totaal"><td colspan="5">Eindsaldo</td>${bedragCel(eind)}</tr></table></div>`}`,
      ),
    );
  });

  r.get("/a/:db/boekstuk/:dagboek/:boekstuk", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const b = await rapport.boekstuk(a.admin_key, req.params.dagboek!, req.params.boekstuk!);
    const loonRe = new RegExp((await import("./rapport.js")).LOON_REKENING, "i");
    const verborgen = !req.g!.lonen && b.regels.some((x: any) => loonRe.test(x.rekening ?? ""));
    await log(req, "bekijk_boekstuk", a.admin_key, { dagboek: req.params.dagboek, boekstuk: req.params.boekstuk });
    const som = b.regels.reduce((t: number, x: any) => t + Number(x.bedrag ?? 0), 0);
    res.type("html").send(
      kader(
        { titel: `Boekstuk ${req.params.boekstuk}`, g: req.g!, admins, admin: a, actief: "mutaties" },
        `<header class="top"><div><h1>Boekstuk ${esc(req.params.dagboek)}·${esc(req.params.boekstuk)}</h1><p class="sub">${esc(adminNaam(a))}</p></div></header>
${verborgen ? `<div class="bericht let">Dit boekstuk raakt loon- of personeelsrekeningen en is voor jouw account verborgen.</div>` : `
<div class="kaart schuif"><table class="lijst"><tr><th>Datum</th><th>Jaar/per.</th><th>Rekening</th><th>Omschrijving</th><th>Relatie</th><th>Factuur</th><th>Btw</th><th>Gebruiker</th><th class="r">Bedrag</th><th>Gezien</th></tr>
${b.regels.map((x: any) => `<tr><td>${datum(x.datum)}</td><td>${esc(x.boekjaar)}/${esc(x.periode)}</td><td>${rekLink(db, x.grootboek, x.boekjaar)} <span class="gedempt">${esc(x.rekening ?? "")}</span></td><td>${esc(x.omschrijving ?? "")}</td><td class="mono">${esc(x.debiteur ?? x.crediteur ?? "")}</td><td class="mono">${esc(x.factuurnr ?? "")}</td><td>${esc(x.btw_code ?? "")}</td><td class="mono">${esc(x.gebruiker ?? "")}</td>${bedragCel(x.bedrag)}<td>${tijdstip(x.eerst_gezien)}${Number(x.versies) > 1 ? ` <span class="badge let">${x.versies} versies</span>` : ""}</td></tr>`).join("")}
<tr class="totaal"><td colspan="8">Saldo boekstuk</td>${bedragCel(som)}<td></td></tr></table></div>
${b.historie.length ? `<h2>Eerdere versies</h2>${historieTabel(b.historie)}` : ""}`}`,
      ),
    );
  });

  function historieTabel(rijen: any[]): string {
    return `<div class="kaart schuif"><table class="lijst"><tr><th>Gezien op</th><th>Soort</th><th>Rij</th><th>Wat veranderde</th></tr>${rijen
      .map((h) => {
        const oud = h.data_oud ?? {};
        const nieuw = h.data_nieuw ?? {};
        const keys = Object.keys({ ...oud, ...nieuw }).filter((k) => JSON.stringify(oud[k]) !== JSON.stringify(nieuw[k]) && !["timestamp", "sysmodified", "sysmodifier", "sysguid"].includes(k));
        const diff =
          h.soort === "verwijderd"
            ? `<details class="diff"><summary>laatste versie</summary><table class="lijst">${Object.entries(oud).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></details>`
            : keys.length
              ? `<table class="lijst">${keys.map((k) => `<tr><td class="mono">${esc(k)}</td><td><del>${esc(oud[k] ?? "")}</del></td><td><ins>${esc(nieuw[k] ?? "")}</ins></td></tr>`).join("")}</table>`
              : `<span class="gedempt">alleen technische velden</span>`;
        return `<tr><td>${tijdstip(h.gemerkt_op)}</td><td><span class="badge ${h.soort === "verwijderd" ? "mis" : "let"}">${esc(h.soort)}</span></td><td class="mono">${esc(h.tbl)} ${esc(h.pk)}</td><td class="diff">${diff}</td></tr>`;
      })
      .join("")}</table></div>`;
  }

  /* ----------------------------------------------------------- wijzigingen */

  r.get("/a/:db/wijzigingen", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const tbl = str(req.query.tbl) ?? null;
    const soort = ["gewijzigd", "verwijderd"].includes(String(req.query.soort)) ? String(req.query.soort) : null;
    const pagina = Math.max(int(req.query.p) ?? 0, 0);
    const w = await rapport.wijzigingen(a.admin_key, tbl, soort, req.g!.lonen, 50, pagina * 50);
    await log(req, "bekijk_wijzigingen", a.admin_key, { tbl, soort });
    res.type("html").send(
      kader(
        { titel: "Wijzigingen", g: req.g!, admins, admin: a, actief: "tabellen", subpad: "/wijzigingen" },
        `<header class="top"><div><h1>Achteraf gewijzigd of verwijderd</h1><p class="sub">${esc(adminNaam(a))} · ${getal(w.aantal)} wijzigingen sinds de eerste sync</p></div>
<form class="filter" method="get"><label>Tabel<input name="tbl" value="${esc(tbl ?? "")}" size="10"></label><label>Soort<select name="soort"><option value="">beide</option><option${soort === "gewijzigd" ? " selected" : ""}>gewijzigd</option><option${soort === "verwijderd" ? " selected" : ""}>verwijderd</option></select></label><button>Filter</button></form></header>
${w.rijen.length ? historieTabel(w.rijen) : `<div class="leeg">Niets gewijzigd of verwijderd.</div>`}
<div class="paginering"><span></span><span class="knoppen">${pagina > 0 ? `<a class="knop" href="${qs({ tbl, soort, p: pagina - 1 })}">Vorige</a>` : ""}${(pagina + 1) * 50 < w.aantal ? `<a class="knop" href="${qs({ tbl, soort, p: pagina + 1 })}">Volgende</a>` : ""}</span></div>`,
      ),
    );
  });

  /* ------------------------------------------------------------ relaties */

  r.get("/a/:db/relaties", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const zoek = str(req.query.zoek) ?? null;
    const rel = await rapport.relaties(a.admin_key, zoek);
    await log(req, "bekijk_relaties", a.admin_key, { zoek });
    res.type("html").send(
      kader(
        { titel: "Relaties", g: req.g!, admins, admin: a, actief: "mutaties", subpad: "/relaties" },
        `<header class="top"><div><h1>Debiteuren en crediteuren</h1><p class="sub">${esc(adminNaam(a))}</p></div>
<form class="filter" method="get"><label>Zoek<input name="zoek" value="${esc(zoek ?? "")}"></label><button>Zoek</button></form></header>
${rel.length ? `<div class="kaart schuif"><table class="lijst"><tr><th>Naam</th><th>Code</th><th>Debiteur</th><th>Crediteur</th><th>Plaats</th><th class="r">Saldo alle jaren</th></tr>${rel
          .map((x: any) => `<tr><td>${esc(x.naam)}</td><td class="mono">${esc(x.code ?? "")}</td><td class="mono">${x.debiteur ? `<a href="/a/${encodeURIComponent(db)}/mutaties${qs({ relatie: x.debiteur })}">${esc(x.debiteur)}</a>` : ""}</td><td class="mono">${x.crediteur ? `<a href="/a/${encodeURIComponent(db)}/mutaties${qs({ relatie: x.crediteur })}">${esc(x.crediteur)}</a>` : ""}</td><td>${esc(x.plaats ?? "")}</td>${bedragCel(x.omzet_som)}</tr>`)
          .join("")}</table></div>` : `<div class="leeg">Geen relaties gevonden.</div>`}`,
      ),
    );
  });

  /* ----------------------------------------------------------------- bank */

  const MAANDEN = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  const achterBadge = (d: unknown) => {
    if (d === null || d === undefined || d === "") return `<span class="gedempt">?</span>`;
    const n = Number(d);
    const k = n <= 7 ? "ok" : n <= 31 ? "let" : "mis";
    return `<span class="badge ${k}">${getal(n)} d</span>`;
  };

  r.get("/a/:db/bank", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const { jaar, jaren } = await jaarUit(req, a.admin_key);
    const lijst = await bank.dagboeken(a.admin_key, jaar);
    const gekozen = lijst.find((x) => x.dagboek === str(req.query.dagboek)) ?? lijst.find((x) => x.soort === "bank") ?? lijst[0];
    const achterQ = str(req.query.achter) ? int(req.query.achter) : undefined;
    const f = {
      jaar: req.query.jaar === "alle" ? undefined : jaar,
      van: str(req.query.van)?.match(/^\d{4}-\d{2}-\d{2}$/) ? str(req.query.van) : undefined,
      tot: str(req.query.tot)?.match(/^\d{4}-\d{2}-\d{2}$/) ? str(req.query.tot) : undefined,
      gebruiker: str(req.query.gebruiker),
      achter: achterQ !== undefined && achterQ >= 0 ? achterQ : undefined,
    };
    const csvExport = req.query.formaat === "csv";
    const pagina = Math.max(int(req.query.p) ?? 0, 0);
    const st = gekozen
      ? await bank.afschriften(a.admin_key, gekozen.dagboek, gekozen.rekening, f, csvExport ? 100_000 : PAGINA, csvExport ? 0 : pagina * PAGINA)
      : { rijen: [], aantal: 0, mutatie: 0 };

    if (csvExport && gekozen) {
      await log(req, "export_bank", a.admin_key, { dagboek: gekozen.dagboek, ...f });
      const kol = [
        ["boekjaar", "Boekjaar"], ["periode", "Periode"], ["dagboek", "Dagboek"], ["boekstuk", "Boekstuk"],
        ["datum_van", "Bankdatum van"], ["datum_tot", "Bankdatum tot"], ["ontvangen", "Ontvangen"], ["betaald", "Betaald"],
        ["mutatie", "Mutatie"], ["regels", "Regels"], ["gebruikers", "Ingevoerd door"], ["ingevoerd_van", "Ingevoerd op"],
        ["ingevoerd_tot", "Laatst ingevoerd"], ["dagen_later", "Dagen na bankdatum"], ["gewijzigd", "Regels gewijzigd"], ["verwijderd", "Regels verwijderd"],
      ].map(([k, label]) => ({ k: k!, label: label! }));
      const dag = (d: unknown) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : d);
      const data = (st.rijen as any[]).map((x) => ({ ...x, datum_van: dag(x.datum_van), datum_tot: dag(x.datum_tot) }));
      return res.type("text/csv; charset=utf-8").attachment(`bank-${db}-${gekozen.dagboek}.csv`).send(csv(kol, data));
    }

    const maanden = gekozen ? await bank.perMaand(a.admin_key, gekozen.dagboek, jaar) : [];
    const ritme = lijst.length ? await bank.invoerdagen(a.admin_key, lijst.map((x) => x.dagboek), 60) : [];
    const samen = await bankregels.samenstelling(a.admin_key);
    const btMaand = samen.length ? await bankregels.perMaand(a.admin_key, 24) : [];
    await log(req, "bekijk_bank", a.admin_key, { dagboek: gekozen?.dagboek, ...f });

    const nu = new Date();
    const vandaag = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate()).getTime();
    const dagenGeleden = (d: unknown) => {
      if (!d) return null;
      const x = d instanceof Date ? d : new Date(String(d));
      return Number.isNaN(x.getTime()) ? null : Math.round((vandaag - new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()) / 86400_000);
    };

    const tegels = lijst
      .map((x) => {
        const geleden2 = dagenGeleden(x.laatste_datum);
        const keuze = qs({ dagboek: x.dagboek, jaar });
        return `<a class="tegel" href="${keuze}"${x.dagboek === gekozen?.dagboek ? ' style="border-color:var(--accent)"' : ""}>
  <div class="label">${esc(x.soort === "kas" ? "Kas" : "Bank")} · dagboek ${esc(x.dagboek)}</div>
  <div class="waarde">${x.saldo === null ? "—" : euro(x.saldo)}</div>
  <div class="noot">${esc(x.naam ?? x.rekening_oms ?? "")}${x.rekening ? ` · rek. <span class="mono">${esc(x.rekening)}</span>` : ""}<br>
  Saldo eind ${jaar} · laatste bankdatum ${datum(x.laatste_datum)}${geleden2 !== null ? ` (${getal(geleden2)} dagen geleden)` : ""}<br>
  Laatst ingevoerd ${x.laatste_invoer ? tijdstip(x.laatste_invoer) : "onbekend"}</div></a>`;
      })
      .join("");

    // Maanden zonder boeking zijn gaten: tot en met vorige maand in het lopende jaar, anders het hele jaar.
    const laatsteMaand = jaar < nu.getFullYear() ? 12 : jaar === nu.getFullYear() ? nu.getMonth() + 1 : 0;
    const perM = new Map(maanden.map((m) => [m.maand, m]));
    const maandRijen = Array.from({ length: Math.max(laatsteMaand, ...maanden.map((m) => m.maand), 0) }, (_, i) => i + 1)
      .map((mnd) => {
        const m = perM.get(mnd);
        const vanaf = `${jaar}-${String(mnd).padStart(2, "0")}-01`;
        const eind = new Date(Date.UTC(jaar, mnd, 0)).toISOString().slice(0, 10);
        if (!m) {
          const lopend = jaar === nu.getFullYear() && mnd === nu.getMonth() + 1;
          return `<tr><td>${MAANDEN[mnd - 1]} ${jaar}</td><td colspan="5">${lopend ? `<span class="badge let">nog niets geboekt</span>` : `<span class="badge mis">geen boekingen</span>`}</td></tr>`;
        }
        return `<tr><td><a href="${qs({ dagboek: gekozen!.dagboek, jaar, van: vanaf, tot: eind })}">${MAANDEN[mnd - 1]} ${jaar}</a></td><td class="r num">${getal(m.boekstukken)}</td><td class="r num">${getal(m.regels)}</td><td class="r">${achterBadge(m.gem_dagen_later)}</td><td class="r">${achterBadge(m.max_dagen_later)}</td><td>${m.laatste_invoer ? tijdstip(m.laatste_invoer) : ""}</td></tr>`;
      })
      .join("");

    const ritmeRijen = ritme
      .map(
        (x: any) =>
          `<tr><td>${datum(x.dag)}</td><td class="mono">${esc(x.gebruiker ?? "")}</td><td class="mono">${esc(x.dagboek)}</td><td class="r num">${getal(x.boekstukken)}</td><td class="r num">${getal(x.regels)}</td><td>${datum(x.bank_van)}${x.bank_van !== x.bank_tot ? ` – ${datum(x.bank_tot)}` : ""}</td><td class="r">${achterBadge(x.gem_dagen_later)}</td><td class="r">${achterBadge(x.max_dagen_later)}</td></tr>`,
      )
      .join("");

    const stRijen = (st.rijen as any[])
      .map(
        (x) =>
          `<tr><td>${datum(x.datum_tot)}${x.datum_van && String(x.datum_van) !== String(x.datum_tot) ? `<br><span class="gedempt">vanaf ${datum(x.datum_van)}</span>` : ""}</td><td>${boekstukLink(db, x.dagboek, x.boekstuk)}</td><td>${esc(x.voorbeeld ?? "")}</td><td class="r num">${getal(x.regels)}</td>${bedragCel(x.ontvangen)}${bedragCel(x.betaald)}${bedragCel(x.mutatie)}<td class="mono">${esc(x.gebruikers ?? "")}</td><td>${x.ingevoerd_van ? tijdstip(x.ingevoerd_van) : `<span class="gedempt">onbekend</span>`}</td><td class="r">${achterBadge(x.dagen_later)}</td><td>${Number(x.gewijzigd) > 0 ? `<span class="badge let">${getal(x.gewijzigd)} gewijzigd</span> ` : ""}${Number(x.verwijderd) > 0 ? `<span class="badge mis">${getal(x.verwijderd)} verwijderd</span>` : ""}</td></tr>`,
      )
      .join("");

    const fq = { dagboek: gekozen?.dagboek, jaar: f.jaar ?? "alle", van: f.van, tot: f.tot, gebruiker: f.gebruiker, achter: f.achter };
    res.type("html").send(
      kader(
        { titel: "Bank", g: req.g!, admins, admin: a, actief: "bank", subpad: "/bank" },
        `<header class="top"><div><h1>Bank</h1><p class="sub">${esc(adminNaam(a))} · wat er in de bank- en kasdagboeken is ingevoerd, door wie en hoe lang na de bankdatum</p></div>
<form class="filter" method="get">${gekozen ? `<input type="hidden" name="dagboek" value="${esc(gekozen.dagboek)}">` : ""}${jaarKiezer(jaren, jaar)}<button>Toon</button></form></header>
${lijst.length === 0 ? `<div class="leeg">Geen bank- of kasdagboek herkend in deze administratie.</div>` : `
<div class="tegels">${tegels}</div>
<p class="uitleg">"Dagen na bankdatum" is het verschil tussen de datum op het afschrift en het moment waarop de regel in Globe is ingevoerd. Tot een week is groen, tot een maand oranje, daarboven rood. Een dagboek dat niet als bank- of kasdagboek in Globe staat, is herkend aan de boekingen.</p>

<h2>Achterstand per maand · dagboek ${esc(gekozen!.dagboek)} · ${jaar}</h2>
<div class="kaart schuif"><table class="lijst"><tr><th>Maand (bankdatum)</th><th class="r">Afschriften</th><th class="r">Regels</th><th class="r">Gem. dagen later</th><th class="r">Max.</th><th>Laatst ingevoerd</th></tr>${maandRijen || `<tr><td colspan="6" class="gedempt">Geen boekingen in ${jaar}.</td></tr>`}</table></div>

<h2>Wanneer is er ingevoerd · laatste 60 dagen</h2>
<p class="uitleg">Per dag dat er bankregels zijn ingevoerd: wie, hoeveel, en over welke bankdata. Een brede reeks bankdata op één dag betekent een inhaalslag.</p>
${ritmeRijen ? `<div class="kaart schuif"><table class="lijst"><tr><th>Ingevoerd op</th><th>Gebruiker</th><th>Dagboek</th><th class="r">Afschriften</th><th class="r">Regels</th><th>Bankdata</th><th class="r">Gem. later</th><th class="r">Max.</th></tr>${ritmeRijen}</table></div>` : `<div class="leeg">Geen bankregels ingevoerd in de afgelopen 60 dagen${ritme.length === 0 && lijst.every((x) => !x.laatste_invoer) ? " (of Globe geeft geen invoermoment mee)" : ""}.</div>`}

<h2>Afschriften · dagboek ${esc(gekozen!.dagboek)}</h2>
<form class="filter" method="get">
  <input type="hidden" name="dagboek" value="${esc(gekozen!.dagboek)}">
  <label>Boekjaar<select name="jaar"><option value="alle"${f.jaar === undefined ? " selected" : ""}>alle</option>${jaren.map((j) => `<option${j === f.jaar ? " selected" : ""}>${j}</option>`).join("")}</select></label>
  <label>Bankdatum van<input type="date" name="van" value="${esc(f.van ?? "")}"></label>
  <label>tot<input type="date" name="tot" value="${esc(f.tot ?? "")}"></label>
  <label>Gebruiker<input name="gebruiker" value="${esc(f.gebruiker ?? "")}" size="8"></label>
  <label>Min. dagen later<input type="number" min="0" name="achter" value="${esc(f.achter ?? "")}" style="width:6rem"></label>
  <button class="primair">Filter</button><a class="knop" href="${qs({ ...fq, formaat: "csv" })}">CSV</a>
</form>
<p class="sub">${getal(st.aantal)} afschriften · netto mutatie ${euro(st.mutatie)}</p>
${stRijen ? `<div class="kaart schuif"><table class="lijst"><tr><th>Bankdatum</th><th>Boekstuk</th><th>Omschrijving</th><th class="r">Regels</th><th class="r">Ontvangen</th><th class="r">Betaald</th><th class="r">Mutatie</th><th>Ingevoerd door</th><th>Ingevoerd op</th><th class="r">Dagen later</th><th></th></tr>${stRijen}</table></div>` : `<div class="leeg">Geen afschriften met deze filters.</div>`}
<div class="paginering"><span>${st.aantal > PAGINA ? `Afschriften ${pagina * PAGINA + 1}–${Math.min((pagina + 1) * PAGINA, st.aantal)} van ${getal(st.aantal)}` : ""}</span><span class="knoppen">${pagina > 0 ? `<a class="knop" href="${qs({ ...fq, p: pagina - 1 })}">Vorige</a>` : ""}${(pagina + 1) * PAGINA < st.aantal ? `<a class="knop" href="${qs({ ...fq, p: pagina + 1 })}">Volgende</a>` : ""}</span></div>`}
${samen.length ? `<h2>Bankregels in Globe (tabel banktransactions)</h2>
<p class="uitleg">Naast de boekingen houdt Globe bankregels bij: ingelezen afschriftregels, betaalopdrachten en termijnen (type <span class="mono">W</span>, openstaande posten). Een regel met een importbestand komt uit een ingelezen bankbestand; zonder bestand is hij in Globe zelf aangemaakt. "Geboekt" betekent: er hangt een boekstuk of koppeling aan. De codes voor type en status zijn die van Globe.</p>
<h2>Per maand (bankdatum), zonder termijnen · laatste 24 maanden</h2>
${btMaand.length ? `<div class="kaart schuif"><table class="lijst"><tr><th>Maand</th><th class="r">Regels</th><th class="r">Uit importbestand</th><th class="r">Bestanden</th><th class="r">Geboekt</th><th class="r">Niet geboekt</th><th>Aangemaakt door</th><th class="r">Gem. dagen later</th></tr>${btMaand
          .map((m: any) => {
            const d = new Date(m.maand);
            const van = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
            const tot = new Date(d.getFullYear(), d.getMonth() + 1, 0);
            const totS = `${tot.getFullYear()}-${String(tot.getMonth() + 1).padStart(2, "0")}-${String(tot.getDate()).padStart(2, "0")}`;
            const pct = Number(m.regels) ? Math.round((Number(m.met_bestand) / Number(m.regels)) * 100) : 0;
            const basis = `/a/${encodeURIComponent(db)}/bank/regels`;
            return `<tr><td><a href="${basis}${qs({ van, tot: totS })}">${MAANDEN[d.getMonth()]} ${d.getFullYear()}</a></td><td class="r num">${getal(m.regels)}</td><td class="r num">${getal(m.met_bestand)} <span class="badge ${pct >= 90 ? "ok" : pct >= 50 ? "let" : "mis"}">${pct}%</span></td><td class="r num">${getal(m.bestanden)}</td><td class="r num">${getal(m.geboekt)}</td><td class="r num">${Number(m.niet_geboekt) ? `<a href="${basis}${qs({ van, tot: totS, geboekt: "nee" })}">${getal(m.niet_geboekt)}</a>` : "0"}</td><td class="mono">${esc(m.aangemaakt_door ?? "")}</td><td class="r">${achterBadge(m.gem_dagen_later)}</td></tr>`;
          })
          .join("")}</table></div>` : `<div class="leeg">Geen bankregels (anders dan termijnen) in de afgelopen 24 maanden.</div>`}
<h2>Samenstelling</h2>
<div class="kaart schuif"><table class="lijst"><tr><th>Type</th><th>Status</th><th>Afschrifttype</th><th>Importbestand</th><th class="r">Regels</th><th>Bankdata</th><th>Laatst aangemaakt</th><th>Laatst gewijzigd</th></tr>${samen
          .map((x: any) => `<tr><td class="mono"><a href="/a/${encodeURIComponent(db)}/bank/regels${qs({ type: x.type ?? "", status: x.status ?? "", bron: x.bestand ? "bestand" : "zonder" })}">${esc(x.type ?? "—")}</a></td><td class="mono">${esc(x.status ?? "—")}</td><td class="mono">${esc(x.afschrifttype ?? "—")}</td><td>${x.bestand ? `<span class="badge ok">ja</span>` : `<span class="badge">nee</span>`}</td><td class="r num">${getal(x.regels)}</td><td>${datum(x.eerste)} – ${datum(x.laatste)}</td><td>${x.laatst_aangemaakt ? tijdstip(x.laatst_aangemaakt) : ""}</td><td>${x.laatst_gewijzigd ? tijdstip(x.laatst_gewijzigd) : ""}</td></tr>`)
          .join("")}</table></div>
<p><a class="knop" href="/a/${encodeURIComponent(db)}/bank/regels">Alle bankregels doorzoeken</a></p>` : ""}`,
      ),
    );
  });

  r.get("/a/:db/bank/regels", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const datumQ = (v: unknown) => (str(v)?.match(/^\d{4}-\d{2}-\d{2}$/) ? str(v) : undefined);
    const f: BankregelFilter = {
      type: str(req.query.type),
      status: str(req.query.status),
      bron: req.query.bron === "bestand" || req.query.bron === "zonder" ? req.query.bron : undefined,
      geboekt: req.query.geboekt === "ja" || req.query.geboekt === "nee" ? req.query.geboekt : undefined,
      van: datumQ(req.query.van),
      tot: datumQ(req.query.tot),
      zoek: str(req.query.zoek),
    };
    const csvExport = req.query.formaat === "csv";
    const pagina = Math.max(int(req.query.p) ?? 0, 0);
    const b = await bankregels.regels(a.admin_key, f, csvExport ? 100_000 : PAGINA, csvExport ? 0 : pagina * PAGINA);
    if (csvExport) {
      await log(req, "export_bankregels", a.admin_key, f);
      const kol = ["datum", "type", "status", "afschrifttype", "afschrift", "afschriftregel", "eigen_rekening", "tegenpartij", "tegenrekening", "omschrijving", "bedrag", "bestand", "boekstuk", "matchid", "grootboek", "tegengrootboek", "debiteur", "crediteur", "factuur", "aangemaakt", "aangemaakt_door", "gewijzigd", "gewijzigd_door", "versies"].map((k) => ({ k, label: k }));
      const dag = (d: unknown) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : d);
      return res.type("text/csv; charset=utf-8").attachment(`bankregels-${db}.csv`).send(csv(kol, (b.rijen as any[]).map((x) => ({ ...x, datum: dag(x.datum) }))));
    }
    await log(req, "bekijk_bankregels", a.admin_key, f);
    const sel = (naam: string, waarde: string | undefined, opties: Array<[string, string]>) =>
      `<select name="${naam}"><option value="">alle</option>${opties.map(([v, l]) => `<option value="${v}"${v === waarde ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    const rijen = (b.rijen as any[])
      .map(
        (x) =>
          `<tr><td>${datum(x.datum)}</td><td class="mono">${esc(x.type ?? "")}/${esc(x.status ?? "")}</td><td class="mono">${esc(x.afschrift ?? "")}${x.afschriftregel ? `·${esc(x.afschriftregel)}` : ""}</td><td>${esc(x.tegenpartij ?? "")}<br><span class="gedempt mono">${esc(x.tegenrekening ?? "")}</span></td><td>${esc(x.omschrijving ?? "")}</td>${bedragCel(x.bedrag)}<td>${x.bestand ? `<span class="badge ok" title="${esc(x.bestand)}">ingelezen</span>` : `<span class="badge">zonder bestand</span>`}</td><td>${x.boekstuk ? `<a class="mono" href="/a/${encodeURIComponent(db)}/mutaties${qs({ zoek: x.boekstuk })}">${esc(x.boekstuk)}</a>` : x.matchid ? `<span class="gedempt mono">match ${esc(x.matchid)}</span>` : `<span class="badge let">niet geboekt</span>`}</td><td>${x.aangemaakt ? tijdstip(x.aangemaakt) : ""} <span class="gedempt mono">${esc(x.aangemaakt_door ?? "")}</span>${Number(x.versies) > 1 ? ` <span class="badge let">${getal(x.versies)} versies</span>` : ""}</td></tr>`,
      )
      .join("");
    res.type("html").send(
      kader(
        { titel: "Bankregels", g: req.g!, admins, admin: a, actief: "bank", subpad: "/bank/regels" },
        `<header class="top"><div><h1>Bankregels</h1><p class="sub">${esc(adminNaam(a))} · tabel banktransactions · ${getal(b.aantal)} regels · saldo ${euro(b.som)}</p></div><div class="knoppen"><a class="knop" href="/a/${encodeURIComponent(db)}/bank">Terug naar Bank</a></div></header>
<form class="filter" method="get">
  <label>Zoek<input name="zoek" value="${esc(f.zoek ?? "")}" placeholder="naam, omschrijving, IBAN, boekstuk"></label>
  <label>Type<input name="type" value="${esc(f.type ?? "")}" size="3" placeholder="niet W"></label>
  <label>Status<input name="status" value="${esc(f.status ?? "")}" size="3"></label>
  <label>Bron${sel("bron", f.bron, [["bestand", "uit importbestand"], ["zonder", "zonder bestand"]])}</label>
  <label>Geboekt${sel("geboekt", f.geboekt, [["ja", "ja"], ["nee", "nee"]])}</label>
  <label>Van<input type="date" name="van" value="${esc(f.van ?? "")}"></label>
  <label>Tot<input type="date" name="tot" value="${esc(f.tot ?? "")}"></label>
  <button class="primair">Zoek</button><a class="knop" href="${qs({ ...f, formaat: "csv" })}">CSV</a>
</form>
<p class="uitleg">${f.type ? "" : "Termijnen (type W, openstaande posten) staan hier niet tussen; vul type W in om ze te zien. "}"Ingelezen" = er hangt een importbestand aan de regel. Klik op het boekstuk voor de boeking.</p>
${rijen ? `<div class="kaart schuif"><table class="lijst"><tr><th>Datum</th><th>Type/status</th><th>Afschrift</th><th>Tegenpartij</th><th>Omschrijving</th><th class="r">Bedrag</th><th>Bron</th><th>Boekstuk</th><th>Aangemaakt</th></tr>${rijen}</table></div>` : `<div class="leeg">Geen bankregels met deze filters.</div>`}
<div class="paginering"><span>${b.aantal > PAGINA ? `Regels ${pagina * PAGINA + 1}–${Math.min((pagina + 1) * PAGINA, b.aantal)} van ${getal(b.aantal)}` : ""}</span><span class="knoppen">${pagina > 0 ? `<a class="knop" href="${qs({ ...f, p: pagina - 1 })}">Vorige</a>` : ""}${(pagina + 1) * PAGINA < b.aantal ? `<a class="knop" href="${qs({ ...f, p: pagina + 1 })}">Volgende</a>` : ""}</span></div>`,
      ),
    );
  });

  /* ---------------------------------------------------- alle gegevens */

  r.get("/a/:db/tabellen", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const t = await rapport.tabellen(a.admin_key);
    await log(req, "bekijk_tabellen", a.admin_key);
    const zicht = (n: string) => req.g!.lonen || !LOON_TABEL.test(n);
    res.type("html").send(
      kader(
        { titel: "Alle gegevens", g: req.g!, admins, admin: a, actief: "tabellen", subpad: "/tabellen" },
        `<header class="top"><div><h1>Alle gegevens</h1><p class="sub">${esc(adminNaam(a))} · elke tabel uit Exact Globe+, zoals de agent hem spiegelt</p></div>
<div class="knoppen"><a class="knop" href="/a/${encodeURIComponent(db)}/relaties">Relaties</a><a class="knop" href="/a/${encodeURIComponent(db)}/wijzigingen">Wijzigingen</a></div></header>
<p class="uitleg">Tabelnamen zijn die van Globe (bijv. <span class="mono">gbkmut</span> = grootboekmutaties, <span class="mono">grtbk</span> = rekeningschema, <span class="mono">cicmpy</span> = relaties, <span class="mono">humres</span> = medewerkers). Lege tabellen zijn weggelaten.${req.g!.lonen ? "" : " Loon- en personeelstabellen zijn voor jouw account verborgen."}</p>
<div class="kaart schuif"><table class="lijst"><tr><th>Tabel</th><th class="r">Rijen</th><th class="r">Kolommen</th><th>Bijgewerkt</th><th>Methode</th></tr>${t
          .filter((x: any) => Number(x.rijen) > 0 && zicht(x.tbl))
          .map((x: any) => `<tr><td><a class="mono" href="/a/${encodeURIComponent(db)}/tabellen/${encodeURIComponent(x.tbl)}">${esc(x.tbl)}</a></td><td class="r num">${getal(x.rijen)}</td><td class="r num">${getal(x.kolommen)}</td><td>${tijdstip(x.laatst_rijen)}</td><td class="gedempt">${esc(x.strategie)}</td></tr>`)
          .join("")}</table></div>`,
      ),
    );
  });

  r.get("/a/:db/tabellen/:tbl", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const tbl = req.params.tbl!;
    if (!req.g!.lonen && LOON_TABEL.test(tbl)) return fout(res, 403, req.g!, admins, "Deze tabel bevat loon- of personeelsgegevens en is voor jouw account niet zichtbaar.");
    const zoek = str(req.query.zoek) ?? null;
    const sorteer = str(req.query.s) ?? null;
    const pagina = Math.max(int(req.query.p) ?? 0, 0);
    const csvExport = req.query.formaat === "csv";
    const t = await rapport.tabel(a.admin_key, tbl, zoek, sorteer, csvExport ? 200_000 : 50, csvExport ? 0 : pagina * 50, req.g!.lonen);
    if (csvExport) {
      await log(req, "export_tabel", a.admin_key, { tbl, zoek });
      return res.type("text/csv; charset=utf-8").attachment(`${tbl}-${db}.csv`).send(csv(t.kolommen.map((k) => ({ k, label: k })), t.rijen.map((x: any) => x.data)));
    }
    await log(req, "bekijk_tabel", a.admin_key, { tbl, zoek });
    const kop = t.kolommen.map((k) => `<th><a href="${qs({ zoek, s: sorteer === k ? `-${k}` : k })}">${esc(k)}${sorteer === k ? " ▲" : sorteer === `-${k}` ? " ▼" : ""}</a></th>`).join("");
    res.type("html").send(
      kader(
        { titel: tbl, g: req.g!, admins, admin: a, actief: "tabellen", subpad: `/tabellen/${encodeURIComponent(tbl)}` },
        `<header class="top"><div><h1 class="mono">${esc(tbl)}</h1><p class="sub">${esc(adminNaam(a))} · ${getal(t.aantal)} rijen</p></div>
<form class="filter" method="get"><label>Zoek in alle kolommen<input name="zoek" value="${esc(zoek ?? "")}"></label>${sorteer ? `<input type="hidden" name="s" value="${esc(sorteer)}">` : ""}<button>Zoek</button><a class="knop" href="${qs({ zoek, s: sorteer, formaat: "csv" })}">CSV</a></form></header>
<div class="kaart schuif"><table class="lijst"><tr>${kop}<th>Gezien</th></tr>${t.rijen
          .map((x: any) => `<tr>${t.kolommen.map((k) => `<td class="${typeof x.data[k] === "number" ? "r num" : ""}">${esc(x.data[k] ?? "")}</td>`).join("")}<td>${datum(x.eerst_gezien)}${Number(x.versies) > 1 ? ` <span class="badge let">${x.versies}×</span>` : ""}</td></tr>`)
          .join("")}</table></div>
<div class="paginering"><span>${t.aantal > 50 ? `Rijen ${pagina * 50 + 1}–${Math.min((pagina + 1) * 50, t.aantal)}` : ""}</span><span class="knoppen">${pagina > 0 ? `<a class="knop" href="${qs({ zoek, s: sorteer, p: pagina - 1 })}">Vorige</a>` : ""}${(pagina + 1) * 50 < t.aantal ? `<a class="knop" href="${qs({ zoek, s: sorteer, p: pagina + 1 })}">Volgende</a>` : ""}</span></div>`,
      ),
    );
  });

  /* ---------------------------------------------------------------- audit */

  const magBeoordelen = (gb: Gebruiker) => gb.rol === "beheerder" || gb.rol === "accountant";

  r.get("/a/:db/audit", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const { jaar, jaren } = await jaarUit(req, a.admin_key);
    const s = await audit.samenvatting(a.admin_key, jaar, req.g!.lonen);
    await log(req, "bekijk_audit", a.admin_key, { jaar });
    res.type("html").send(
      kader(
        { titel: "Audit", g: req.g!, admins, admin: a, actief: "audit", subpad: "/audit" },
        `<header class="top"><div><h1>Audit</h1><p class="sub">${esc(adminNaam(a))} · ${jaar} · ${s.reduce((t, x) => t + x.open, 0)} open bevindingen</p></div>
<form class="filter" method="get">${jaarKiezer(jaren, jaar)}<button>Toon</button></form></header>
<p class="uitleg">Signalen, geen oordelen. Elke bevinding kan ${magBeoordelen(req.g!) ? "je" : "de accountant of beheerder"} beoordelen als akkoord, vraag of afwijking, met een opmerking. Alle beoordelingen blijven bewaard als spoor.</p>
<div class="controles">${s
          .map(
            (x) =>
              `<a class="controle ${x.fout ? "open" : x.open > 0 ? "open" : "schoon"}" href="/a/${encodeURIComponent(db)}/audit/${x.c.id}?jaar=${jaar}"><div class="titel">${esc(x.c.titel)}</div><div class="tel">${x.fout ? `<span class="badge mis">fout</span> ${esc(x.fout).slice(0, 120)}` : x.aantal === 0 ? `<span class="badge ok">niets gevonden</span>` : `${getal(x.aantal)} bevinding(en) · <strong>${getal(x.open)} open</strong>`}</div></a>`,
          )
          .join("")}</div>`,
      ),
    );
  });

  function auditCel(c: Kolom, rij: Record<string, any>, db: string, jaar: number): string {
    const v = rij[c.k];
    switch (c.soort) {
      case "bedrag":
        return bedragCel(v);
      case "datum":
        return `<td>${datum(v)}</td>`;
      case "tijd":
        return `<td>${tijdstip(v)}</td>`;
      case "getal":
        return `<td class="r num">${getal(v)}</td>`;
      case "boekstuk":
        return `<td>${boekstukLink(db, rij.dagboek, rij.boekstuk)}</td>`;
      case "grootboek":
        return `<td>${rekLink(db, v, jaar)}</td>`;
      case "diff":
        return `<td class="diff">${v ? `<table class="lijst">${Object.entries(v as Record<string, [unknown, unknown]>).map(([k, [o2, n]]) => `<tr><td class="mono">${esc(k)}</td><td><del>${esc(o2 ?? "")}</del></td><td><ins>${esc(n ?? "")}</ins></td></tr>`).join("")}</table>` : ""}</td>`;
      default:
        return `<td>${esc(v ?? "")}</td>`;
    }
  }

  r.get("/a/:db/audit/:controle", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a, admins } = ctx;
    const db = a.slug;
    const c = audit.controle(req.params.controle!);
    if (!c) return fout(res, 404, req.g!, admins, "Onbekende controle.");
    const { jaar, jaren } = await jaarUit(req, a.admin_key);
    const filter = ["open", "alle", "akkoord", "vraag", "afwijking"].includes(String(req.query.toon)) ? String(req.query.toon) : "open";
    let rijen: Array<Record<string, any>>;
    try {
      rijen = await audit.bevindingen(a.admin_key, jaar, c, req.g!.lonen);
    } catch (e) {
      return fout(res, 500, req.g!, admins, `Controle mislukt: ${e instanceof Error ? e.message : e}`);
    }
    const b = await audit.beoordelingen(a.admin_key, c.id);
    const metStatus: Array<Record<string, any>> = rijen.map((x) => ({ ...x, _b: b.get(String(x.sleutel)) }));
    const zichtbaar = metStatus.filter((x) => (filter === "alle" ? true : filter === "open" ? x._b?.status !== "akkoord" : x._b?.status === filter));

    if (req.query.formaat === "csv") {
      await log(req, "export_audit", a.admin_key, { controle: c.id, jaar });
      const kol = [...c.kolommen.filter((k) => k.soort !== "diff"), ...(c.kolommen.some((k) => k.soort === "boekstuk") ? [{ k: "dagboek", label: "Dagboek" }] : []), { k: "_status", label: "Beoordeling" }, { k: "_opmerking", label: "Opmerking" }, { k: "_door", label: "Door" }, { k: "_tijd", label: "Op" }];
      const data = metStatus.map((x) => ({ ...x, _status: x._b?.status ?? "open", _opmerking: x._b?.opmerking ?? "", _door: x._b?.naam ?? "", _tijd: x._b?.tijd ?? "" }));
      return res.type("text/csv; charset=utf-8").attachment(`audit-${c.id}-${db}-${jaar}.csv`).send(csv(kol, data));
    }

    await log(req, "bekijk_auditcontrole", a.admin_key, { controle: c.id, jaar });
    const mag = magBeoordelen(req.g!);
    const terug = `/a/${encodeURIComponent(db)}/audit/${c.id}${qs({ jaar, toon: filter })}`;
    const tabel = zichtbaar
      .map((x) => {
        const st = x._b;
        const badge = st ? `<span class="badge ${st.status === "akkoord" ? "ok" : st.status === "vraag" ? "let" : "mis"}" title="${esc(`${st.naam ?? ""}, ${tijdstip(st.tijd)}`)}">${esc(st.status)}</span>${st.opmerking ? `<div class="gedempt" style="font-size:.78rem">${esc(st.opmerking)} — ${esc(st.naam ?? "")}, ${tijdstip(st.tijd)}</div>` : ""}` : `<span class="badge">open</span>`;
        const form = mag
          ? `<form class="beoordeel" method="post" action="/a/${encodeURIComponent(db)}/audit/${c.id}/beoordeel"><input type="hidden" name="sleutel" value="${esc(x.sleutel)}"><input type="hidden" name="terug" value="${esc(terug)}"><select name="status"><option value="akkoord">akkoord</option><option value="vraag">vraag</option><option value="afwijking">afwijking</option></select><input name="opmerking" placeholder="opmerking" maxlength="500"><button class="klein">Leg vast</button></form>`
          : "";
        return `<tr>${c.kolommen.map((k) => auditCel(k, x, db, jaar)).join("")}<td>${badge}${form}</td></tr>`;
      })
      .join("");
    res.type("html").send(
      kader(
        { titel: c.titel, g: req.g!, admins, admin: a, actief: "audit", subpad: `/audit/${c.id}` },
        `<header class="top"><div><h1>${esc(c.titel)}</h1><p class="sub">${esc(adminNaam(a))} · ${jaar} · ${getal(rijen.length)} bevindingen, ${getal(metStatus.filter((x) => x._b?.status !== "akkoord").length)} open</p></div>
<form class="filter" method="get">${jaarKiezer(jaren, jaar)}<label>Toon<select name="toon">${["open", "alle", "akkoord", "vraag", "afwijking"].map((t) => `<option${t === filter ? " selected" : ""}>${t}</option>`).join("")}</select></label><button>Toon</button><a class="knop" href="${qs({ jaar, formaat: "csv" })}">CSV met beoordelingen</a></form></header>
<p class="uitleg">${esc(c.uitleg)}${c.kanttekening ? `<br><em>${esc(c.kanttekening)}</em>` : ""}</p>
${meldingen(req.query)}
${tabel ? `<div class="kaart schuif"><table class="lijst"><tr>${c.kolommen.map((k) => `<th${["bedrag", "getal"].includes(k.soort ?? "") ? ' class="r"' : ""}>${esc(k.label)}</th>`).join("")}<th>Beoordeling</th></tr>${tabel}</table></div>` : `<div class="leeg">${rijen.length ? "Alles in deze selectie is beoordeeld." : "Niets gevonden voor dit boekjaar."}</div>`}
<p><a href="/a/${encodeURIComponent(db)}/audit?jaar=${jaar}">← Alle controles</a></p>`,
      ),
    );
  });

  r.post("/a/:db/audit/:controle/beoordeel", async (req, res) => {
    const ctx = await adminUit(req, res);
    if (!ctx) return;
    const { a } = ctx;
    if (!magBeoordelen(req.g!)) return res.status(403).send("Alleen de accountant of beheerder kan beoordelen.");
    const c = audit.controle(req.params.controle!);
    const status = String(req.body?.status ?? "");
    const sleutel = String(req.body?.sleutel ?? "").slice(0, 300);
    if (!c || !["akkoord", "vraag", "afwijking"].includes(status) || !sleutel) return res.status(400).send("Ongeldige beoordeling.");
    const opmerking = String(req.body?.opmerking ?? "").trim().slice(0, 500);
    await audit.beoordeel({ admin: a.admin_key, controle: c.id, sleutel, status, opmerking, gebruikerId: req.g!.id, naam: req.g!.naam });
    await log(req, "audit_beoordeling", a.admin_key, { controle: c.id, sleutel, status, opmerking });
    const terug = veiligTerug(req.body?.terug);
    res.redirect(303, terug + (terug.includes("?") ? "&" : "?") + "ok=" + encodeURIComponent("Beoordeling vastgelegd."));
  });

  /* --------------------------------------------------------------- beheer */

  const alleenBeheerder: express.RequestHandler = (req, res, next) => {
    if (req.g?.rol !== "beheerder") return void res.status(403).send("Alleen voor de beheerder.");
    next();
  };

  const beheerNav = (actief: string) =>
    `<div class="knoppen" style="margin:.4rem 0 1rem">${[
      ["", "Gebruikers"],
      ["/logboek", "Logboek"],
      ["/administraties", "Administraties"],
      ["/sync", "Synchronisatie"],
    ]
      .map(([p, l]) => `<a class="knop${p === actief ? " primair" : ""}" href="/beheer${p}">${l}</a>`)
      .join("")}</div>`;

  r.get("/beheer", alleenBeheerder, async (req, res) => {
    const admins = await g.admins(req.g!);
    const lijst = await g.lijst();
    const uitnodiging = str(req.query.uitnodiging);
    const adminVinkjes = (gekozen: string[]) =>
      admins.map((a) => `<label style="display:flex;gap:.35rem;align-items:center;font-size:.85rem;color:var(--inkt)"><input type="checkbox" name="admins" value="${esc(a.admin_key)}"${gekozen.includes(a.admin_key) ? " checked" : ""}> ${esc(adminNaam(a))}</label>`).join("");
    const rolKeuze = (rol: Rol) => `<select name="rol">${(["aandeelhouder", "accountant", "beheerder"] as Rol[]).map((x) => `<option${x === rol ? " selected" : ""}>${x}</option>`).join("")}</select>`;
    const basis = o.publicUrl ?? `https://${req.header("host")}`;
    res.type("html").send(
      kader(
        { titel: "Beheer", g: req.g!, admins, actief: "beheer" },
        `<header class="top"><div><h1>Beheer</h1><p class="sub">Accounts, toegang en logboek</p></div></header>
${beheerNav("")}
${meldingen(req.query)}
${uitnodiging ? `<div class="bericht ok">Uitnodigingslink (7 dagen geldig, eenmalig). Stuur hem zelf door; hij wordt niet opnieuw getoond:<br><span class="mono" style="word-break:break-all">${esc(`${basis}/uitnodiging?t=${uitnodiging}`)}</span></div>` : ""}
<h2>Gebruikers</h2>
<div class="kaart schuif"><table class="lijst"><tr><th>Naam</th><th>Rol</th><th>Lonen</th><th>Administraties</th><th>Status</th><th>Laatst ingelogd</th><th></th></tr>
${lijst
  .map(
    (u) => `<tr><td>${esc(u.naam)}<div class="gedempt" style="font-size:.8rem">${esc(u.email)}</div></td>
<td colspan="3"><form method="post" action="/beheer/gebruiker/${u.id}" class="knoppen" style="align-items:flex-start">${rolKeuze(u.rol)}
<label style="font-size:.85rem"><input type="checkbox" name="lonen" value="1"${u.lonen ? " checked" : ""}> lonen</label>
<div>${u.rol === "beheerder" ? `<span class="gedempt" style="font-size:.85rem">alle</span>` : adminVinkjes(u.admins)}</div>
<button class="klein" name="actie" value="wijzig">Opslaan</button></form></td>
<td>${u.actief ? `<span class="badge ok">actief</span>` : u.uitnodiging_tot ? `<span class="badge let">uitgenodigd tot ${datum(u.uitnodiging_tot)}</span>` : `<span class="badge">uit</span>`}</td>
<td>${tijdstip(u.laatst_ingelogd)}</td>
<td><form method="post" action="/beheer/gebruiker/${u.id}" class="knoppen">${u.id !== req.g!.id ? `<button class="klein" name="actie" value="uitnodigen" title="Nieuwe link; wachtwoord en authenticator moeten opnieuw">Nieuwe uitnodiging</button>${u.actief ? `<button class="klein" name="actie" value="uitschakelen">Uitschakelen</button>` : ""}` : `<span class="gedempt">jij</span>`}</form></td></tr>`,
  )
  .join("")}</table></div>
<h2>Iemand uitnodigen</h2>
<form method="post" action="/beheer/uitnodigen" class="kaart" style="padding:1rem;display:grid;gap:.7rem;max-width:40rem">
  <div class="knoppen"><label style="display:grid;gap:.2rem;font-size:.75rem;color:var(--gedempt)">Naam<input name="naam" required></label>
  <label style="display:grid;gap:.2rem;font-size:.75rem;color:var(--gedempt)">E-mailadres<input name="email" type="email" required></label>
  <label style="display:grid;gap:.2rem;font-size:.75rem;color:var(--gedempt)">Rol${rolKeuze("aandeelhouder")}</label></div>
  <label style="font-size:.85rem"><input type="checkbox" name="lonen" value="1"> Mag loon- en personeelsgegevens zien</label>
  <div><div class="gedempt" style="font-size:.75rem;margin-bottom:.3rem">Administraties (niet nodig voor een beheerder)</div>${adminVinkjes([])}</div>
  <div><button class="primair">Uitnodiging maken</button></div>
  <p class="uitleg" style="margin:0">Aandeelhouder: alles bekijken, niets beoordelen. Accountant: bekijken, exporteren en auditbevindingen beoordelen. Beheerder: alles, inclusief accounts.</p>
</form>`,
      ),
    );
  });

  const alsLijst = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
  const geldigeRol = (v: unknown): Rol => (["beheerder", "aandeelhouder", "accountant"].includes(String(v)) ? (String(v) as Rol) : "aandeelhouder");

  r.post("/beheer/uitnodigen", alleenBeheerder, async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.redirect(303, `/beheer?fout=${encodeURIComponent("Ongeldig e-mailadres.")}`);
    const bestaand = (await g.lijst()).find((u) => u.email === email);
    if (bestaand?.actief) return res.redirect(303, `/beheer?fout=${encodeURIComponent("Er bestaat al een actief account met dit adres. Gebruik 'Nieuwe uitnodiging' in de lijst.")}`);
    const rol = geldigeRol(req.body?.rol);
    const { code } = await g.uitnodigen({ email, naam: String(req.body?.naam ?? email), rol, lonen: req.body?.lonen === "1", admins: alsLijst(req.body?.admins) });
    await log(req, "gebruiker_uitgenodigd", null, { email, rol, lonen: req.body?.lonen === "1", admins: alsLijst(req.body?.admins) });
    res.redirect(303, `/beheer?uitnodiging=${encodeURIComponent(code)}`);
  });

  r.post("/beheer/gebruiker/:id", alleenBeheerder, async (req, res) => {
    const id = int(req.params.id);
    const u = id ? await g.metId(id) : null;
    if (!u) return res.redirect(303, "/beheer?fout=Onbekende+gebruiker");
    const actie = String(req.body?.actie ?? "");
    if (actie === "wijzig") {
      const rol = geldigeRol(req.body?.rol);
      if (u.id === req.g!.id && rol !== "beheerder") return res.redirect(303, `/beheer?fout=${encodeURIComponent("Je kunt jezelf geen beheerder af maken.")}`);
      await g.wijzigen(u.id, { rol, lonen: req.body?.lonen === "1", admins: alsLijst(req.body?.admins) });
      await log(req, "gebruiker_gewijzigd", null, { email: u.email, rol, lonen: req.body?.lonen === "1", admins: alsLijst(req.body?.admins) });
      return res.redirect(303, `/beheer?ok=${encodeURIComponent(`${u.naam} bijgewerkt.`)}`);
    }
    if (u.id === req.g!.id) return res.redirect(303, "/beheer");
    if (actie === "uitschakelen") {
      await g.uitschakelen(u.id);
      await log(req, "gebruiker_uitgeschakeld", null, { email: u.email });
      return res.redirect(303, `/beheer?ok=${encodeURIComponent(`${u.naam} uitgeschakeld; lopende sessies zijn beëindigd.`)}`);
    }
    if (actie === "uitnodigen") {
      const admins = (await g.lijst()).find((x) => x.id === u.id)?.admins ?? [];
      const { code } = await g.uitnodigen({ email: u.email, naam: u.naam, rol: u.rol, lonen: u.lonen, admins });
      await log(req, "gebruiker_opnieuw_uitgenodigd", null, { email: u.email });
      return res.redirect(303, `/beheer?uitnodiging=${encodeURIComponent(code)}`);
    }
    res.redirect(303, "/beheer");
  });

  r.get("/beheer/logboek", alleenBeheerder, async (req, res) => {
    const admins = await g.admins(req.g!);
    const wie = str(req.query.wie) ?? null;
    const rijen = (
      await o.pool.query(
        `SELECT tijd, email, actie, admin_key, pad, ip, detail FROM portaal_log
          WHERE ($1::text IS NULL OR email ILIKE '%' || $1 || '%') ORDER BY tijd DESC LIMIT 500`,
        [wie],
      )
    ).rows;
    const naamVan = new Map(admins.map((a) => [a.admin_key, adminNaam(a)]));
    res.type("html").send(
      kader(
        { titel: "Logboek", g: req.g!, admins, actief: "beheer" },
        `<header class="top"><div><h1>Logboek</h1><p class="sub">Wie heeft wat bekeken, geëxporteerd of beoordeeld — de laatste 500</p></div>
<form class="filter" method="get"><label>Gebruiker<input name="wie" value="${esc(wie ?? "")}"></label><button>Filter</button></form></header>
${beheerNav("/logboek")}
<div class="kaart schuif"><table class="lijst"><tr><th>Tijd</th><th>Wie</th><th>Actie</th><th>Administratie</th><th>Details</th></tr>${rijen
          .map((x: any) => `<tr><td class="num">${tijdstip(x.tijd)}</td><td>${esc(x.email ?? "")}</td><td>${esc(x.actie)}</td><td>${esc(naamVan.get(x.admin_key) ?? "")}</td><td class="mono" style="font-size:.75rem;max-width:30rem;overflow-wrap:anywhere">${esc(x.detail ? JSON.stringify(x.detail) : (x.pad ?? ""))}</td></tr>`)
          .join("")}</table></div>`,
      ),
    );
  });

  r.get("/beheer/administraties", alleenBeheerder, async (req, res) => {
    const admins = await g.admins(req.g!);
    res.type("html").send(
      kader(
        { titel: "Administraties", g: req.g!, admins, actief: "beheer" },
        `<header class="top"><div><h1>Administraties</h1><p class="sub">Zoals de agent ze op de Globe-pc heeft gevonden</p></div></header>
${beheerNav("/administraties")}
${meldingen(req.query)}
<div class="kaart schuif"><table class="lijst"><tr><th>Naam</th><th>Database</th><th>Bron</th><th>Laatste sync</th><th>Afgeschermd voor Claude</th></tr>${admins
          .map((a) => `<tr><td>${esc(adminNaam(a))}</td><td class="mono">${esc(a.database_name)}</td><td class="mono gedempt">${esc(a.bron ?? a.admin_key)}</td><td>${tijdstip(a.laatst_sync)}</td><td><form method="post" action="/beheer/administraties" class="knoppen"><input type="hidden" name="admin" value="${esc(a.admin_key)}"><input type="hidden" name="afgeschermd" value="${a.afgeschermd ? "0" : "1"}"><span class="badge ${a.afgeschermd ? "let" : ""}">${a.afgeschermd ? "ja" : "nee"}</span><button class="klein">${a.afgeschermd ? "Opheffen" : "Afschermen"}</button></form></td></tr>`)
          .join("")}</table></div>
<p class="uitleg">Afschermen geldt alleen voor de leestools in Claude: Claude vraagt dan eerst om uitdrukkelijke bevestiging. In het portaal regel je zichtbaarheid per account bij Gebruikers.</p>`,
      ),
    );
  });

  r.post("/beheer/administraties", alleenBeheerder, async (req, res) => {
    const admin = String(req.body?.admin ?? "");
    const aan = req.body?.afgeschermd === "1";
    await o.pool.query(`UPDATE globe_admin SET afgeschermd = $2 WHERE admin_key = $1`, [admin, aan]);
    await log(req, "administratie_afscherming", admin, { afgeschermd: aan });
    res.redirect(303, "/beheer/administraties?ok=Bijgewerkt");
  });

  r.get("/beheer/sync", alleenBeheerder, async (req, res) => {
    const admins = await g.admins(req.g!);
    const s = await rapport.sync(null);
    const per = await Promise.all(admins.map(async (a) => ({ a, t: (await rapport.sync(a.admin_key)).tabellen })));
    res.type("html").send(
      kader(
        { titel: "Synchronisatie", g: req.g!, admins, actief: "beheer" },
        `<header class="top"><div><h1>Synchronisatie</h1><p class="sub">De agent op de Globe-pc meldt zich elk half uur zolang die aanstaat</p></div></header>
${beheerNav("/sync")}
<h2>Agent installeren of bijwerken</h2>
<p class="uitleg">Download beide bestanden naar één map op de pc met Exact Globe+, open PowerShell als administrator in die map en voer uit: <span class="mono">powershell -ExecutionPolicy Bypass -File .\\Installeer.ps1</span>. Het script vraagt om de agent-token (Railway › VDA Book › vdabook › Variables › AGENT_TOKEN).</p>
<div class="knoppen"><a class="knop primair" href="/beheer/agent/Installeer.ps1">Installeer.ps1</a><a class="knop primair" href="/beheer/agent/GlobeSync.ps1">GlobeSync.ps1</a></div>
<h2>Laatste runs</h2>
${s.runs.length ? `<div class="kaart schuif"><table class="lijst"><tr><th>Gestart</th><th>Pc</th><th>Versie</th><th>Duur</th><th>Status</th><th>Meldingen</th></tr>${s.runs
          .map((x: any) => `<tr><td>${tijdstip(x.gestart)}</td><td class="mono">${esc(x.host ?? "")}</td><td>${esc(x.versie ?? "")}</td><td class="num">${x.detail?.seconden != null ? `${x.detail.seconden} s` : ""}</td><td>${x.geeindigd ? (x.ok ? `<span class="badge ok">ok</span>` : `<span class="badge mis">fouten</span>`) : `<span class="badge let">bezig of afgebroken</span>`}</td><td style="font-size:.8rem">${esc((x.detail?.fouten ?? []).join("; ")).slice(0, 400)}</td></tr>`)
          .join("")}</table></div>` : `<div class="leeg">De agent heeft zich nog niet gemeld.</div>`}
${per
  .map(
    ({ a, t }) => `<h2>${esc(adminNaam(a))}</h2><div class="kaart schuif"><table class="lijst"><tr><th>Tabel</th><th>Methode</th><th class="r">In Globe</th><th class="r">In spiegel</th><th>Laatst bijgewerkt</th><th>Laatste sleutelscan</th></tr>${t
      .filter((x: any) => Number(x.bron_aantal) > 0 || Number(x.spiegel) > 0)
      .map((x: any) => `<tr><td class="mono">${esc(x.tbl)}</td><td class="gedempt">${esc(x.strategie)}</td><td class="r num">${getal(x.bron_aantal)}</td><td class="r num">${getal(x.spiegel)}${Math.abs(Number(x.bron_aantal) - Number(x.spiegel)) > Math.max(5, Number(x.bron_aantal) * 0.01) ? ` <span class="badge let">verschil</span>` : ""}</td><td>${tijdstip(x.laatst_rijen)}</td><td>${tijdstip(x.laatst_sleutelscan)}</td></tr>`)
      .join("")}</table></div>`,
  )
  .join("")}`,
      ),
    );
  });

  // De agentbestanden, zodat de installatie op de Globe-pc zonder GitHub kan.
  const agentMap = [join(here, "..", "..", "agent"), join(here, "..", "..", "..", "agent")].find((p) => existsSync(p));
  r.get("/beheer/agent/:bestand", alleenBeheerder, async (req, res) => {
    const naam = String(req.params.bestand);
    if (!agentMap || !["Installeer.ps1", "GlobeSync.ps1"].includes(naam)) return res.status(404).send("Niet gevonden.");
    await log(req, "agent_gedownload", null, { naam });
    res.type("text/plain; charset=utf-8").attachment(naam).send(readFileSync(join(agentMap, naam)));
  });

  return r;
}
