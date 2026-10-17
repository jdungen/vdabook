import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const { Pool } = pg;

/**
 * Opslag voor de OAuth-laag: clients, autorisatieverzoeken, codes en tokens.
 *
 * Gedeeld door beide services. Het MCP-proces maakt verzoeken, codes en tokens;
 * core schrijft uitsluitend het besluit van een mens op een verzoek. De database
 * is daarmee het kanaal tussen de twee — er is geen extra gedeeld geheim of
 * ondertekende URL nodig, en core hoeft niets van tokens te weten.
 *
 * Alles wat als geheim in een URL of header reist (verzoek-id, code, token)
 * staat hier alleen als SHA-256-hash.
 */

export type VerzoekStatus = "open" | "goedgekeurd" | "geweigerd" | "afgehandeld";

export interface Verzoek {
  clientId: string;
  clientNaam: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scopes: string[];
  resource: string | null;
  status: VerzoekStatus;
  verlooptOp: Date;
}

export interface CodeRij {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string | null;
  familie: string;
}

export interface TokenRij {
  clientId: string;
  familie: string;
  scopes: string[];
  resource: string | null;
  verlooptOp: Date;
}

export interface Koppeling {
  familie: string;
  clientId: string;
  clientNaam: string;
  sinds: Date;
  laatstVernieuwd: Date;
  verlooptOp: Date;
}

export interface UitgegevenTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export const hash = (geheim: string): string =>
  createHash("sha256").update(geheim, "utf8").digest("hex");

/** 256 bits willekeur met een herkenbaar voorvoegsel, handig bij een lek-scan. */
const nieuwGeheim = (voorvoegsel: string): string =>
  `${voorvoegsel}_${randomBytes(32).toString("base64url")}`;

export class OAuthOpslag {
  private pool: pg.Pool;

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) throw new Error("DATABASE_URL ontbreekt — OAuth heeft Postgres nodig.");
    this.pool = new Pool({ connectionString, max: 3 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /* ------------------------------------------------------------- clients */

  async clientOphalen(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await this.pool.query<{ info: OAuthClientInformationFull }>(
      `SELECT info FROM oauth_clients WHERE client_id = $1`,
      [clientId],
    );
    return rows[0]?.info;
  }

  async clientOpslaan(info: OAuthClientInformationFull): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, info) VALUES ($1, $2)`,
      [info.client_id, JSON.stringify(info)],
    );
  }

  /* ------------------------------------------------------------ verzoeken */

  async verzoekMaken(
    v: Omit<Verzoek, "clientNaam" | "status" | "verlooptOp">,
    geldigMs: number,
  ): Promise<string> {
    const id = nieuwGeheim("gsv");
    await this.pool.query(
      `INSERT INTO oauth_verzoeken
         (id_hash, client_id, redirect_uri, state, code_challenge, scopes, resource, verloopt_op)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
      [hash(id), v.clientId, v.redirectUri, v.state, v.codeChallenge, v.scopes, v.resource, geldigMs / 1000],
    );
    return id;
  }

  /** Voor het toestemmingsscherm: alleen open en niet verlopen verzoeken. */
  async verzoekLezen(id: string): Promise<Verzoek | null> {
    const { rows } = await this.pool.query(
      `SELECT v.*, c.info->>'client_name' AS client_naam
         FROM oauth_verzoeken v JOIN oauth_clients c USING (client_id)
        WHERE v.id_hash = $1 AND v.status = 'open' AND v.verloopt_op > now()`,
      [hash(id)],
    );
    const r = rows[0];
    return r ? naarVerzoek(r) : null;
  }

  /** Legt het besluit van een mens vast. Werkt maar één keer per verzoek. */
  async verzoekBesluiten(id: string, besluit: "goedgekeurd" | "geweigerd"): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE oauth_verzoeken SET status = $2, beslist_op = now()
        WHERE id_hash = $1 AND status = 'open' AND verloopt_op > now()`,
      [hash(id), besluit],
    );
    return rowCount === 1;
  }

  /**
   * Sluit een besloten verzoek af en geeft het besluit terug. Atomair: een
   * tweede aanroep met hetzelfde id levert niets meer op, dus één toestemming
   * levert precies één code.
   */
  async verzoekAfhandelen(id: string): Promise<(Verzoek & { besluit: "goedgekeurd" | "geweigerd" }) | null> {
    const { rows } = await this.pool.query(
      `UPDATE oauth_verzoeken v SET status = 'afgehandeld'
         FROM (SELECT id_hash, status AS oud FROM oauth_verzoeken WHERE id_hash = $1 FOR UPDATE) o
        WHERE v.id_hash = o.id_hash
          AND o.oud IN ('goedgekeurd', 'geweigerd')
          AND v.verloopt_op > now()
      RETURNING v.*, o.oud, ''::text AS client_naam`,
      [hash(id)],
    );
    const r = rows[0];
    return r ? { ...naarVerzoek(r), besluit: r.oud } : null;
  }

  /* ---------------------------------------------------------------- codes */

  async codeMaken(v: Verzoek, geldigMs: number): Promise<string> {
    const code = nieuwGeheim("gsc");
    await this.pool.query(
      `INSERT INTO oauth_codes
         (code_hash, client_id, redirect_uri, code_challenge, scopes, resource, verloopt_op)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
      [hash(code), v.clientId, v.redirectUri, v.codeChallenge, v.scopes, v.resource, geldigMs / 1000],
    );
    return code;
  }

  async codeChallenge(code: string, clientId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ code_challenge: string }>(
      `SELECT code_challenge FROM oauth_codes
        WHERE code_hash = $1 AND client_id = $2 AND gebruikt_op IS NULL AND verloopt_op > now()`,
      [hash(code), clientId],
    );
    if (rows[0]) return rows[0].code_challenge;
    // De SDK vraagt eerst de challenge op en komt bij een al gebruikte code
    // nooit bij codeInwisselen. Het intrekken bij hergebruik moet dus hier.
    const { rows: oud } = await this.pool.query<{ familie: string }>(
      `SELECT familie FROM oauth_codes WHERE code_hash = $1 AND gebruikt_op IS NOT NULL`,
      [hash(code)],
    );
    if (oud[0]) await this.familieIntrekken(oud[0].familie);
    return null;
  }

  /**
   * Wisselt een code in, eenmalig. Wordt een al gebruikte code nog eens
   * aangeboden, dan is die onderschept of gelekt: alle tokens die eruit zijn
   * voortgekomen gaan dicht (OAuth 2.1, §4.1.3).
   */
  async codeInwisselen(code: string, clientId: string): Promise<CodeRij | null> {
    const { rows } = await this.pool.query(
      `UPDATE oauth_codes SET gebruikt_op = now()
        WHERE code_hash = $1 AND client_id = $2 AND gebruikt_op IS NULL AND verloopt_op > now()
      RETURNING *`,
      [hash(code), clientId],
    );
    if (rows[0]) return naarCode(rows[0]);

    const { rows: oud } = await this.pool.query<{ familie: string }>(
      `SELECT familie FROM oauth_codes WHERE code_hash = $1 AND gebruikt_op IS NOT NULL`,
      [hash(code)],
    );
    if (oud[0]) await this.familieIntrekken(oud[0].familie);
    return null;
  }

  /* --------------------------------------------------------------- tokens */

  async tokensUitgeven(
    c: Pick<CodeRij, "clientId" | "familie" | "scopes" | "resource">,
    accessMs: number,
    refreshMs: number,
  ): Promise<UitgegevenTokens> {
    const accessToken = nieuwGeheim("gsa");
    const refreshToken = nieuwGeheim("gsr");
    await this.pool.query(
      `INSERT INTO oauth_tokens (token_hash, soort, client_id, familie, scopes, resource, verloopt_op)
       VALUES ($1, 'access',  $3, $4, $5, $6, now() + make_interval(secs => $7)),
              ($2, 'refresh', $3, $4, $5, $6, now() + make_interval(secs => $8))`,
      [hash(accessToken), hash(refreshToken), c.clientId, c.familie, c.scopes, c.resource,
        accessMs / 1000, refreshMs / 1000],
    );
    return { accessToken, refreshToken, expiresIn: Math.floor(accessMs / 1000) };
  }

  /**
   * Roteert een refresh token: de oude gaat dicht, de aanroeper geeft een nieuw
   * paar uit. Een ingetrokken refresh token dat terugkomt betekent dat iemand
   * anders hem ook heeft; dan gaat de hele familie dicht.
   */
  async refreshInwisselen(token: string, clientId: string): Promise<TokenRij | null> {
    const { rows } = await this.pool.query(
      `UPDATE oauth_tokens SET ingetrokken_op = now()
        WHERE token_hash = $1 AND soort = 'refresh' AND client_id = $2
          AND ingetrokken_op IS NULL AND verloopt_op > now()
      RETURNING *`,
      [hash(token), clientId],
    );
    if (rows[0]) return naarToken(rows[0]);

    const { rows: oud } = await this.pool.query<{ familie: string }>(
      `SELECT familie FROM oauth_tokens
        WHERE token_hash = $1 AND soort = 'refresh' AND ingetrokken_op IS NOT NULL`,
      [hash(token)],
    );
    if (oud[0]) await this.familieIntrekken(oud[0].familie);
    return null;
  }

  async accessControleren(token: string): Promise<TokenRij | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM oauth_tokens
        WHERE token_hash = $1 AND soort = 'access'
          AND ingetrokken_op IS NULL AND verloopt_op > now()`,
      [hash(token)],
    );
    return rows[0] ? naarToken(rows[0]) : null;
  }

  /** Trekt de familie in waar dit token bij hoort; onbekend token doet niets. */
  async tokenIntrekken(token: string, clientId: string): Promise<void> {
    const { rows } = await this.pool.query<{ familie: string }>(
      `SELECT familie FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2`,
      [hash(token), clientId],
    );
    if (rows[0]) await this.familieIntrekken(rows[0].familie);
  }

  async familieIntrekken(familie: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE oauth_tokens SET ingetrokken_op = now()
        WHERE familie = $1 AND ingetrokken_op IS NULL`,
      [familie],
    );
    return rowCount ?? 0;
  }

  /** Actieve koppelingen: families met een geldig refresh token. */
  async koppelingen(): Promise<Koppeling[]> {
    const { rows } = await this.pool.query(
      `SELECT t.familie, t.client_id, c.info->>'client_name' AS client_naam,
              min(a.created_at) AS sinds, max(t.created_at) AS laatst, max(t.verloopt_op) AS verloopt
         FROM oauth_tokens t
         JOIN oauth_clients c USING (client_id)
         JOIN oauth_tokens a ON a.familie = t.familie
        WHERE t.soort = 'refresh' AND t.ingetrokken_op IS NULL AND t.verloopt_op > now()
        GROUP BY t.familie, t.client_id, c.info
        ORDER BY laatst DESC`,
    );
    return rows.map((r) => ({
      familie: r.familie,
      clientId: r.client_id,
      clientNaam: r.client_naam ?? r.client_id,
      sinds: r.sinds,
      laatstVernieuwd: r.laatst,
      verlooptOp: r.verloopt,
    }));
  }

  /** Ruimt verlopen rommel op. Clients blijven staan: claude.ai hergebruikt ze. */
  async opruimen(): Promise<void> {
    await this.pool.query(`DELETE FROM oauth_verzoeken WHERE verloopt_op < now() - interval '1 day'`);
    await this.pool.query(`DELETE FROM oauth_codes WHERE verloopt_op < now() - interval '1 day'`);
    await this.pool.query(`DELETE FROM oauth_tokens WHERE verloopt_op < now() - interval '7 days'`);
  }
}

/* --------------------------------------------------------------- mappers */

function naarVerzoek(r: Record<string, any>): Verzoek {
  return {
    clientId: r.client_id,
    clientNaam: r.client_naam || r.client_id,
    redirectUri: r.redirect_uri,
    state: r.state,
    codeChallenge: r.code_challenge,
    scopes: r.scopes,
    resource: r.resource,
    status: r.status,
    verlooptOp: r.verloopt_op,
  };
}

function naarCode(r: Record<string, any>): CodeRij {
  return {
    clientId: r.client_id,
    redirectUri: r.redirect_uri,
    codeChallenge: r.code_challenge,
    scopes: r.scopes,
    resource: r.resource,
    familie: r.familie,
  };
}

function naarToken(r: Record<string, any>): TokenRij {
  return {
    clientId: r.client_id,
    familie: r.familie,
    scopes: r.scopes,
    resource: r.resource,
    verlooptOp: r.verloopt_op,
  };
}
