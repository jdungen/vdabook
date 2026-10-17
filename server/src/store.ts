import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

export interface TabelMelding {
  tbl: string;
  strategie: "rowversion" | "sysmodified" | "volledig";
  sleutel: string[];
  kolommen: string[];
  bron_aantal?: number;
}

export interface AdminMelding {
  admin_key: string;
  database: string;
  bron?: string | null;
  bedrijfsnaam?: string | null;
  tabellen: TabelMelding[];
}

export interface TabelToestand {
  overslaan?: boolean;
  strategie: string;
  watermerk: string | null;
  laatst_sleutelscan: string | null;
}

/** Hoeveel verwijderingen we in één sleutelscan blind toestaan. */
const MAX_VERWIJDER_ABS = 100;
const MAX_VERWIJDER_FRACTIE = 0.2;

export class Store {
  readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly afschermPatroon: RegExp | null,
    /** Tabellen die de agent niet hoeft te sturen (naam, kleine letters). */
    private readonly overslaanPatroon: RegExp | null = null,
  ) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async migrate(): Promise<void> {
    const sql = readFileSync(join(here, "..", "db", "schema.sql"), "utf8");
    await this.pool.query(sql);
    await this.pool.query(`DELETE FROM globe_keyscan WHERE aangemaakt < now() - interval '1 day'`);
  }

  /**
   * Aparte databaserol voor de MCP-leestools: geen superuser, standaard
   * read-only, alleen SELECT op de spiegel (niet op accounts, logboek of
   * OAuth). Zo kan ook een vrije SQL-vraag geen schade doen of geheimen lezen,
   * los van wat de applicatie zelf afvangt. Het wachtwoord is afgeleid van een
   * geheim uit de omgeving en wordt bij elke start opnieuw gezet.
   * Geeft een pool terug, of null als de rol niet aangemaakt kon worden.
   */
  async lezerPool(connectionString: string, geheim: string): Promise<pg.Pool | null> {
    const ww = createHmac("sha256", geheim).update("vda_lezer").digest("hex");
    try {
      await this.pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vda_lezer') THEN CREATE ROLE vda_lezer LOGIN; END IF;
      END $$`);
      await this.pool.query(`ALTER ROLE vda_lezer WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${ww}'`);
      await this.pool.query(`ALTER ROLE vda_lezer SET default_transaction_read_only = on`);
      await this.pool.query(`ALTER ROLE vda_lezer SET statement_timeout = '20s'`);
      await this.pool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await this.pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vda_lezer`);
      await this.pool.query(`GRANT USAGE ON SCHEMA public TO vda_lezer`);
      await this.pool.query(
        `GRANT SELECT ON globe_admin, globe_row, globe_row_historie, globe_sync_state, globe_run, gb_mutatie,
                         v_grootboekmutaties, v_grootboekrekeningen, v_relaties TO vda_lezer`,
      );
      const u = new URL(connectionString);
      u.username = "vda_lezer";
      u.password = ww;
      const p = new pg.Pool({ connectionString: u.toString(), max: 3 });
      const r = await p.query<{ su: boolean }>(`SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user`);
      if (r.rows[0]?.su) throw new Error("vda_lezer is onverwacht superuser");
      return p;
    } catch (e) {
      console.error("[lezer] aparte leesrol niet beschikbaar; de SQL-tool staat uit:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Begin van een run: legt de administraties en tabellen vast die de agent
   * ziet en geeft per tabel het watermerk terug. Verandert de strategie of de
   * sleutel van een tabel (Globe-update), dan begint die tabel opnieuw.
   */
  async start(
    agent: string,
    host: string | null,
    versie: string | null,
    admins: AdminMelding[],
  ): Promise<{ runId: string; toestand: Record<string, Record<string, TabelToestand>> }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{ id: string }>(
        `INSERT INTO globe_run (agent, host, versie) VALUES ($1, $2, $3) RETURNING id`,
        [agent, host, versie],
      );
      const toestand: Record<string, Record<string, TabelToestand>> = {};

      for (const a of admins) {
        const afgeschermd =
          !!this.afschermPatroon &&
          (this.afschermPatroon.test(a.bedrijfsnaam ?? "") || this.afschermPatroon.test(a.database));
        // afgeschermd wordt alleen áángezet door de automaat; uitzetten is een
        // bewuste handeling in de database, niet iets wat een naamswijziging doet.
        await client.query(
          `INSERT INTO globe_admin (admin_key, database_name, bedrijfsnaam, afgeschermd, bron)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (admin_key) DO UPDATE
              SET database_name = EXCLUDED.database_name,
                  bron          = COALESCE(EXCLUDED.bron, globe_admin.bron),
                  bedrijfsnaam  = COALESCE(EXCLUDED.bedrijfsnaam, globe_admin.bedrijfsnaam),
                  afgeschermd   = globe_admin.afgeschermd OR EXCLUDED.afgeschermd`,
          [a.admin_key, a.database, a.bedrijfsnaam ?? null, afgeschermd, a.bron ?? null],
        );

        toestand[a.admin_key] = {};
        for (const t of a.tabellen) {
          const { rows } = await client.query<{
            strategie: string;
            watermerk: string | null;
            sleutel: string[] | null;
            laatst_sleutelscan: Date | null;
          }>(
            `SELECT strategie, watermerk, sleutel, laatst_sleutelscan
               FROM globe_sync_state WHERE admin_key = $1 AND tbl = $2`,
            [a.admin_key, t.tbl],
          );
          const oud = rows[0];
          const zelfde =
            oud &&
            oud.strategie === t.strategie &&
            JSON.stringify(oud.sleutel ?? []) === JSON.stringify(t.sleutel);
          const watermerk = zelfde ? oud.watermerk : null;
          const scan = zelfde ? oud.laatst_sleutelscan : null;

          await client.query(
            `INSERT INTO globe_sync_state (admin_key, tbl, strategie, watermerk, sleutel, kolommen, bron_aantal, laatst_sleutelscan)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (admin_key, tbl) DO UPDATE
                SET strategie = EXCLUDED.strategie,
                    watermerk = EXCLUDED.watermerk,
                    sleutel = EXCLUDED.sleutel,
                    kolommen = EXCLUDED.kolommen,
                    bron_aantal = EXCLUDED.bron_aantal,
                    laatst_sleutelscan = EXCLUDED.laatst_sleutelscan`,
            [
              a.admin_key,
              t.tbl,
              t.strategie,
              watermerk,
              JSON.stringify(t.sleutel),
              JSON.stringify(t.kolommen),
              t.bron_aantal ?? null,
              scan,
            ],
          );
          toestand[a.admin_key]![t.tbl] = {
            ...(this.overslaanPatroon?.test(t.tbl) ? { overslaan: true } : {}),
            strategie: t.strategie,
            watermerk,
            laatst_sleutelscan: scan ? scan.toISOString() : null,
          };
        }
      }
      await client.query("COMMIT");
      return { runId: run.rows[0]!.id, toestand };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Upsert van een blok rijen; het watermerk schuift pas mee als het blok binnen is. */
  async rijen(
    adminKey: string,
    tbl: string,
    rijen: { pk: string; data: unknown }[],
    watermerk: string | null | undefined,
  ): Promise<{ verwerkt: number }> {
    // Dubbele sleutels binnen één blok zouden ON CONFLICT laten struikelen.
    const uniek = new Map<string, unknown>();
    for (const r of rijen) uniek.set(String(r.pk), r.data);
    const payload = JSON.stringify([...uniek].map(([pk, data]) => ({ pk, data })));

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.adminBestaat(client, adminKey);
      if (uniek.size > 0) {
        // Eerst de oude versie bewaren van alles wat werkelijk verandert.
        await client.query(
          `INSERT INTO globe_row_historie (admin_key, tbl, pk, soort, data_oud, data_nieuw)
           SELECT r.admin_key, r.tbl, r.pk, 'gewijzigd', r.data, e->'data'
             FROM jsonb_array_elements($3::jsonb) e
             JOIN globe_row r ON r.admin_key = $1 AND r.tbl = $2 AND r.pk = e->>'pk'
            WHERE r.data IS DISTINCT FROM e->'data'`,
          [adminKey, tbl, payload],
        );
        await client.query(
          `INSERT INTO globe_row (admin_key, tbl, pk, data)
           SELECT $1, $2, e->>'pk', e->'data' FROM jsonb_array_elements($3::jsonb) e
           ON CONFLICT (admin_key, tbl, pk) DO UPDATE
              SET data = EXCLUDED.data, synced_at = now(), versies = globe_row.versies + 1
            WHERE globe_row.data IS DISTINCT FROM EXCLUDED.data`,
          [adminKey, tbl, payload],
        );
      }
      if (watermerk !== undefined) {
        await client.query(
          `UPDATE globe_sync_state SET watermerk = $3, laatst_rijen = now()
            WHERE admin_key = $1 AND tbl = $2`,
          [adminKey, tbl, watermerk],
        );
      }
      await client.query("COMMIT");
      return { verwerkt: uniek.size };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Sleutelscan voor verwijderingen. De agent stuurt in blokken alle sleutels
   * die nu in Globe staan; bij het laatste blok verdwijnt wat er niet meer is.
   * Een verdacht grote verwijdering wordt niet uitgevoerd maar gemeld.
   */
  async sleutels(
    scanId: string,
    adminKey: string,
    tbl: string,
    sleutels: string[],
    laatste: boolean,
  ): Promise<{ verwijderd: number; overgeslagen?: string }> {
    await this.pool.query(
      `INSERT INTO globe_keyscan (scan_id, admin_key, tbl, pk)
       SELECT $1, $2, $3, k FROM jsonb_array_elements_text($4::jsonb) k
       ON CONFLICT DO NOTHING`,
      [scanId, adminKey, tbl, JSON.stringify(sleutels)],
    );
    if (!laatste) return { verwijderd: 0 };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tel = await client.query<{ bestaand: string; weg: string; gescand: string }>(
        `SELECT (SELECT count(*) FROM globe_row WHERE admin_key = $1 AND tbl = $2) AS bestaand,
                (SELECT count(*) FROM globe_row r
                  WHERE r.admin_key = $1 AND r.tbl = $2
                    AND NOT EXISTS (SELECT 1 FROM globe_keyscan k WHERE k.scan_id = $3 AND k.pk = r.pk)) AS weg,
                (SELECT count(*) FROM globe_keyscan WHERE scan_id = $3) AS gescand`,
        [adminKey, tbl, scanId],
      );
      const bestaand = Number(tel.rows[0]!.bestaand);
      const weg = Number(tel.rows[0]!.weg);
      const gescand = Number(tel.rows[0]!.gescand);

      let overgeslagen: string | undefined;
      let verwijderd = 0;
      if (gescand === 0 && bestaand > 0) {
        overgeslagen = `sleutelscan leeg terwijl er ${bestaand} rijen zijn — niets verwijderd`;
      } else if (weg > MAX_VERWIJDER_ABS && weg > bestaand * MAX_VERWIJDER_FRACTIE) {
        overgeslagen = `${weg} van ${bestaand} rijen zouden verdwijnen — boven de veiligheidsgrens, niets verwijderd`;
      } else if (weg > 0) {
        await client.query(
          `INSERT INTO globe_row_historie (admin_key, tbl, pk, soort, data_oud)
           SELECT r.admin_key, r.tbl, r.pk, 'verwijderd', r.data FROM globe_row r
            WHERE r.admin_key = $1 AND r.tbl = $2
              AND NOT EXISTS (SELECT 1 FROM globe_keyscan k WHERE k.scan_id = $3 AND k.pk = r.pk)`,
          [adminKey, tbl, scanId],
        );
        const r = await client.query(
          `DELETE FROM globe_row r
            WHERE r.admin_key = $1 AND r.tbl = $2
              AND NOT EXISTS (SELECT 1 FROM globe_keyscan k WHERE k.scan_id = $3 AND k.pk = r.pk)`,
          [adminKey, tbl, scanId],
        );
        verwijderd = r.rowCount ?? 0;
      }
      if (!overgeslagen) {
        await client.query(
          `UPDATE globe_sync_state SET laatst_sleutelscan = now() WHERE admin_key = $1 AND tbl = $2`,
          [adminKey, tbl],
        );
      }
      await client.query(`DELETE FROM globe_keyscan WHERE scan_id = $1`, [scanId]);
      await client.query("COMMIT");
      return overgeslagen ? { verwijderd, overgeslagen } : { verwijderd };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async einde(runId: string, ok: boolean, detail: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE globe_run SET geeindigd = now(), ok = $2, detail = $3 WHERE id = $1`,
      [runId, ok, JSON.stringify(detail ?? null)],
    );
    if (ok) {
      const klaar: string[] = Array.isArray((detail as { admins?: unknown })?.admins)
        ? ((detail as { admins: unknown[] }).admins.map(String))
        : [];
      await this.pool.query(
        `UPDATE globe_admin SET laatst_sync = now() WHERE admin_key = ANY($1)`,
        [klaar],
      );
      // Na de eerste volledige ronde geldt alles wat erbij komt als nieuw.
      await this.pool.query(
        `UPDATE globe_sync_state SET initieel_klaar = now()
          WHERE initieel_klaar IS NULL AND laatst_rijen IS NOT NULL AND admin_key = ANY($1)`,
        [klaar],
      );
    }
  }

  async status(): Promise<unknown> {
    const admins = await this.pool.query(
      `SELECT a.admin_key, a.database_name, a.bedrijfsnaam, a.afgeschermd, a.laatst_sync,
              COALESCE(json_agg(json_build_object(
                'tbl', s.tbl, 'strategie', s.strategie, 'bron_aantal', s.bron_aantal,
                'spiegel_aantal', (SELECT count(*) FROM globe_row r WHERE r.admin_key = s.admin_key AND r.tbl = s.tbl),
                'laatst_rijen', s.laatst_rijen, 'laatst_sleutelscan', s.laatst_sleutelscan
              ) ORDER BY s.tbl) FILTER (WHERE s.tbl IS NOT NULL), '[]') AS tabellen
         FROM globe_admin a LEFT JOIN globe_sync_state s USING (admin_key)
        GROUP BY a.admin_key ORDER BY a.admin_key`,
    );
    const runs = await this.pool.query(
      `SELECT id, agent, host, versie, gestart, geeindigd, ok, detail
         FROM globe_run ORDER BY gestart DESC LIMIT 10`,
    );
    return { administraties: admins.rows, laatste_runs: runs.rows };
  }

  private async adminBestaat(client: pg.PoolClient, adminKey: string): Promise<void> {
    const r = await client.query(`SELECT 1 FROM globe_admin WHERE admin_key = $1`, [adminKey]);
    if (r.rowCount === 0) throw new Fout(400, `Onbekende administratie ${adminKey}; eerst /agent/start`);
  }
}

export class Fout extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
