import express from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";
import { Fout, Store, type AdminMelding } from "./store.js";
import { OAuthOpslag } from "./oauth-opslag.js";
import { GlobeOAuth, SCOPE } from "./oauth.js";
import { registerTools } from "./tools.js";
import { foutPagina } from "./pagina.js";
import { Kluis } from "./kluis.js";
import { Gebruikers } from "./portaal/gebruikers.js";
import { portaal } from "./portaal/routes.js";

/**
 * Globe-spiegel.
 *
 * - /agent/*  : de Windows-agent op de pc bij Van Dungen Automaten duwt hier
 *               rijen naartoe (bearer AGENT_TOKEN). De pc zelf is nergens van
 *               buitenaf bereikbaar.
 * - /mcp      : leestools voor Claude (OAuth voor claude.ai, of MCP_AUTH_TOKEN).
 * - /oauth/*  : OAuth voor claude.ai; toestemming door een ingelogde beheerder + TOTP.
 * - overige   : het portaal (inzicht, audit, beheer) met eigen accounts.
 *
 * Er bestaat geen code-pad dat iets naar Globe terugschrijft.
 */

function vereist(naam: string, minLengte = 0): string {
  const v = process.env[naam];
  if (!v || v.length < minLengte) {
    throw new Error(`${naam} ontbreekt of is korter dan ${minLengte} tekens.`);
  }
  return v;
}

const DATABASE_URL = vereist("DATABASE_URL");
const AGENT_TOKEN = vereist("AGENT_TOKEN", 32);
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN && process.env.MCP_AUTH_TOKEN.length >= 32 ? process.env.MCP_AUTH_TOKEN : null;
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/+$/, "") ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);
const SESSION_SECRET = vereist("SESSION_SECRET", 32);
const SLEUTEL_KLUIS = vereist("SLEUTEL_KLUIS", 32);
const AFSCHERM = process.env.AFSCHERM_PATROON ? new RegExp(process.env.AFSCHERM_PATROON, "i") : null;

/** Vergelijking in constante tijd, ongeacht lengte. */
function tokenGelijk(gegeven: string, verwacht: string): boolean {
  const a = createHash("sha256").update(gegeven).digest();
  const b = createHash("sha256").update(verwacht).digest();
  return timingSafeEqual(a, b);
}

function bearer(req: express.Request): string {
  const h = req.header("authorization") ?? "";
  return /^bearer /i.test(h) ? h.slice(7).trim() : "";
}

const OVERSLAAN = process.env.OVERSLAAN_TABELLEN ? new RegExp(process.env.OVERSLAAN_TABELLEN, "i") : null;
const store = new Store(DATABASE_URL, AFSCHERM, OVERSLAAN);
await store.migrate();

// Eenmalig opschonen na een test, aangestuurd via variabelen (daarna weghalen):
//   OPSCHONEN_PC=<hostnaam>        administraties en runs van die pc
//   OPSCHONEN_GEBRUIKER=<e-mail>   dat account en zijn logregels
if (process.env.OPSCHONEN_PC) {
  const pc = process.env.OPSCHONEN_PC;
  const a = await store.pool.query(`DELETE FROM globe_admin WHERE starts_with(admin_key, $1 || '\\') OR starts_with(COALESCE(bron, ''), $1 || '\\') RETURNING admin_key`, [pc]);
  const r = await store.pool.query(`DELETE FROM globe_run WHERE host = $1`, [pc]);
  await store.pool.query(`DELETE FROM gb_mutatie m WHERE NOT EXISTS (SELECT 1 FROM globe_admin a WHERE a.admin_key = m.admin_key)`);
  console.warn(`[opschonen] pc ${pc}: ${a.rowCount} administratie(s) en ${r.rowCount} run(s) verwijderd`);
}
if (process.env.OPSCHONEN_GEBRUIKER) {
  const e = process.env.OPSCHONEN_GEBRUIKER.toLowerCase();
  const l = await store.pool.query(`DELETE FROM portaal_log WHERE lower(email) = $1`, [e]);
  const g = await store.pool.query(`DELETE FROM portaal_gebruiker WHERE email = $1`, [e]);
  console.warn(`[opschonen] gebruiker ${e}: ${g.rowCount} account, ${l.rowCount} logregels verwijderd`);
}
//   OPSCHONEN_OAUTH_CLIENT=<client_name>  die OAuth-koppelingen met al hun tokens
if (process.env.OPSCHONEN_OAUTH_CLIENT) {
  const c = await store.pool.query(`DELETE FROM oauth_clients WHERE info->>'client_name' = $1`, [process.env.OPSCHONEN_OAUTH_CLIENT]);
  console.warn(`[opschonen] ${c.rowCount} OAuth-client(s) "${process.env.OPSCHONEN_OAUTH_CLIENT}" met tokens verwijderd`);
}

// Tabellen opnieuw laten inlezen, eenmalig per waarde (een herstart doet het
// niet nog eens):  HERINLEZEN=001:gbkmut,banktransactions;002:grtbk
// Het watermerk gaat terug naar leeg, zodat de agent de hele tabel weer stuurt.
// Bestaande rijen blijven staan; de sleutelscan ruimt daarna op wat echt weg is.
if (process.env.HERINLEZEN) {
  const waarde = process.env.HERINLEZEN.trim();
  const sleutel = `herinlezen:${waarde}`;
  const al = await store.pool.query(`SELECT 1 FROM app_eenmalig WHERE sleutel = $1`, [sleutel]);
  if (al.rowCount) {
    console.log(`[herinlezen] "${waarde}" is al eerder uitgevoerd; variabele mag weg`);
  } else {
    const delen: string[] = [];
    for (const deel of waarde.split(";").map((s) => s.trim()).filter(Boolean)) {
      const [db, lijst] = deel.split(":");
      const tabellen = (lijst ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (!db || !tabellen.length) continue;
      const r = await store.pool.query(
        `UPDATE globe_sync_state s SET watermerk = NULL, initieel_klaar = NULL
           FROM globe_admin a
          WHERE a.admin_key = s.admin_key AND a.database_name = $1 AND s.tbl = ANY($2)
          RETURNING s.admin_key, s.tbl`,
        [db.trim(), tabellen],
      );
      delen.push(`${db.trim()}: ${r.rows.map((x) => x.tbl).join(", ") || "geen tabellen gevonden"}`);
    }
    const resultaat = delen.join("; ");
    await store.pool.query(`INSERT INTO app_eenmalig (sleutel, resultaat) VALUES ($1, $2)`, [sleutel, resultaat]);
    console.warn(`[herinlezen] watermerk teruggezet — ${resultaat}`);
  }
}

// Referentiecijfers uit de jaarrekeningen (JSON in de omgeving, niet in git):
// { "<stuk bedrijfsnaam>": { "<jaar>": { "<post>": bedrag, ... }, "_bron": "..." } }
if (process.env.JAARREKENING_REF) {
  try {
    const ref = JSON.parse(process.env.JAARREKENING_REF) as Record<string, Record<string, unknown>>;
    let n = 0;
    await store.pool.query("DELETE FROM jaarrekening_ref");
    for (const [bedrijf, jaren] of Object.entries(ref)) {
      const bron = typeof jaren._bron === "string" ? jaren._bron : null;
      for (const [jaar, posten] of Object.entries(jaren)) {
        if (!/^\d{4}$/.test(jaar) || typeof posten !== "object" || !posten) continue;
        for (const [post, bedrag] of Object.entries(posten as Record<string, unknown>)) {
          if (typeof bedrag !== "number") continue;
          await store.pool.query(`INSERT INTO jaarrekening_ref (bedrijf, jaar, post, bedrag, bron) VALUES ($1, $2, $3, $4, $5)`, [bedrijf, Number(jaar), post, bedrag, bron]);
          n++;
        }
      }
    }
    console.log(`[jaarrekening] ${n} referentiecijfers geladen`);
  } catch (e) {
    console.error("[jaarrekening] JAARREKENING_REF onleesbaar:", e instanceof Error ? e.message : e);
  }
}

// MCP-leestools draaien als vda_lezer; lukt dat niet, dan geen MCP-leestoegang
// tot de database via een rol met meer rechten.
const lezer = await store.lezerPool(DATABASE_URL, process.env.SESSION_SECRET ?? AGENT_TOKEN);

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "globe-spiegel" });
});

/* ------------------------------------------------------------------ agent */

const agent = express.Router();
// Ruime limiet: de agent stuurt blokken van een paar duizend rijen, gzipt.
agent.use(express.json({ limit: "64mb", inflate: true }));
agent.use((req, res, next) => {
  if (!tokenGelijk(bearer(req), AGENT_TOKEN)) {
    res.status(401).json({ fout: "Ongeldige agent-token." });
    return;
  }
  next();
});

const asyncRoute =
  (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((e: unknown) => {
      const status = e instanceof Fout ? e.status : 500;
      console.error(`[agent] ${req.path}:`, e);
      res.status(status).json({ fout: e instanceof Error ? e.message : String(e) });
    });
  };

agent.post(
  "/start",
  asyncRoute(async (req, res) => {
    const b = req.body ?? {};
    if (!Array.isArray(b.admins)) throw new Fout(400, "admins ontbreekt");
    const r = await store.start(String(b.agent ?? "onbekend"), b.host ?? null, b.versie ?? null, b.admins as AdminMelding[]);
    console.log(`[agent] run ${r.runId} van ${b.host} (${b.versie}), ${b.admins.length} administratie(s)`);
    res.json({ run_id: r.runId, toestand: r.toestand, sleutelscan_na_uren: Number(process.env.SLEUTELSCAN_UREN ?? 20) });
  }),
);

agent.post(
  "/rijen",
  asyncRoute(async (req, res) => {
    const b = req.body ?? {};
    if (!b.admin_key || !b.tbl || !Array.isArray(b.rijen)) throw new Fout(400, "admin_key, tbl en rijen zijn verplicht");
    const r = await store.rijen(String(b.admin_key), String(b.tbl), b.rijen, "watermerk" in b ? b.watermerk : undefined);
    res.json(r);
  }),
);

agent.post(
  "/sleutels",
  asyncRoute(async (req, res) => {
    const b = req.body ?? {};
    if (!b.scan_id || !b.admin_key || !b.tbl || !Array.isArray(b.sleutels)) {
      throw new Fout(400, "scan_id, admin_key, tbl en sleutels zijn verplicht");
    }
    const r = await store.sleutels(String(b.scan_id), String(b.admin_key), String(b.tbl), b.sleutels.map(String), b.laatste === true);
    if (r.overgeslagen) console.warn(`[agent] ${b.admin_key}/${b.tbl}: ${r.overgeslagen}`);
    res.json(r);
  }),
);

agent.post(
  "/einde",
  asyncRoute(async (req, res) => {
    const b = req.body ?? {};
    if (!b.run_id) throw new Fout(400, "run_id ontbreekt");
    await store.einde(String(b.run_id), b.ok === true, b.detail);
    console.log(`[agent] run ${b.run_id} klaar, ok=${b.ok === true}`);
    res.json({ ok: true });
  }),
);

agent.get(
  "/status",
  asyncRoute(async (_req, res) => {
    res.json(await store.status());
  }),
);

app.use("/agent", agent);

/* ------------------------------------------------------------------ OAuth */

const OAUTH_REDIRECTS = (
  process.env.OAUTH_REDIRECT_URIS ?? "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let oauth: GlobeOAuth | null = null;
let resourceMetadataUrl: string | null = null;

let oauthOpslag: OAuthOpslag | null = null;
if (PUBLIC_URL) {
  const resourceUrl = new URL("/mcp", PUBLIC_URL);
  const opslag = new OAuthOpslag(DATABASE_URL);
  oauthOpslag = opslag;
  oauth = new GlobeOAuth(opslag, {
    resourceUrl,
    coreUrl: new URL(PUBLIC_URL),
    toegestaneRedirects: OAUTH_REDIRECTS,
    loopbackToestaan: process.env.OAUTH_LOOPBACK === "1",
  });
  resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);

  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl: new URL(PUBLIC_URL),
      resourceServerUrl: resourceUrl,
      scopesSupported: [SCOPE],
      resourceName: "Exact Globe-spiegel (alleen lezen)",
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    }),
  );
  app.use(
    "/.well-known/oauth-protected-resource",
    metadataHandler({
      resource: resourceUrl.href,
      authorization_servers: [new URL(PUBLIC_URL).href],
      scopes_supported: [SCOPE],
      resource_name: "Exact Globe-spiegel (alleen lezen)",
    }),
  );

  app.get("/oauth/terug", async (req, res) => {
    const id = typeof req.query.verzoek === "string" ? req.query.verzoek : "";
    const doel = id ? await oauth!.afronden(id) : null;
    if (!doel) {
      res.status(400).type("html").send(foutPagina("Dit koppelverzoek is verlopen of al gebruikt. Start de koppeling opnieuw vanuit Claude."));
      return;
    }
    res.set("Cache-Control", "no-store").redirect(302, doel);
  });

  setInterval(() => void opslag.opruimen().catch((e) => console.error("[oauth] opruimen:", e)), 60 * 60_000).unref();
  console.log(`[oauth] aan — issuer ${PUBLIC_URL}; toestemming via de portaalinlog van een beheerder`);
} else {
  console.warn("[oauth] uit: PUBLIC_URL ontbreekt. claude.ai kan zo niet koppelen; MCP_AUTH_TOKEN werkt wel.");
}

/* -------------------------------------------------------------------- MCP */

async function mcpToegestaan(req: express.Request): Promise<boolean> {
  const t = bearer(req);
  if (!t) return false;
  if (MCP_AUTH_TOKEN && tokenGelijk(t, MCP_AUTH_TOKEN)) return true;
  if (!oauth) return false;
  try {
    const info = await oauth.verifyAccessToken(t);
    return info.scopes.includes(SCOPE);
  } catch {
    return false;
  }
}

app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
  if (!(await mcpToegestaan(req))) {
    res.set("WWW-Authenticate", resourceMetadataUrl ? `Bearer resource_metadata="${resourceMetadataUrl}", scope="${SCOPE}"` : "Bearer");
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Ongeldige of ontbrekende bearer token." }, id: null });
    return;
  }
  const server = new McpServer({ name: "globe-spiegel", version: "1.0.0" });
  if (!lezer) {
    res.status(503).json({ jsonrpc: "2.0", error: { code: -32603, message: "Leestoegang tijdelijk niet beschikbaar (leesrol ontbreekt)." }, id: null });
    return;
  }
  registerTools(server, lezer);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: err instanceof Error ? err.message : "Interne fout" }, id: null });
    }
  }
});

app.all("/mcp", (_req, res) => {
  res.set("Allow", "POST").status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Alleen POST wordt ondersteund." }, id: null });
});

/* ----------------------------------------------------------------- portaal */

const gebruikers = new Gebruikers(store.pool, new Kluis(SLEUTEL_KLUIS));
app.use(
  portaal({
    pool: store.pool,
    gebruikers,
    sessieGeheim: SESSION_SECRET,
    publicUrl: PUBLIC_URL,
    setupCode: process.env.SETUP_CODE,
    beheerderEmail: process.env.BEHEERDER_EMAIL,
    oauthOpslag,
  }),
);

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "::";
app.listen(port, host, () => console.log(`[globe-spiegel] luistert op :${port} (${randomUUID().slice(0, 8)})`));
