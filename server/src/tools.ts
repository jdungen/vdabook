import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { z } from "zod";

/**
 * Leestools op de Globe-spiegel. Alles hier is read-only: de spiegel kent geen
 * schrijfpad terug naar Globe, en de SQL-tool draait in een READ ONLY-transactie.
 */

const TEKENLIMIET = 60_000;

function tekst(data: unknown, hint = "Verfijn de vraag of verlaag de limiet.") {
  let t = JSON.stringify(data, null, 2);
  if (t.length > TEKENLIMIET) t = t.slice(0, TEKENLIMIET) + `\n\n[AFGEKAPT op ${TEKENLIMIET} tekens. ${hint}]`;
  return { content: [{ type: "text" as const, text: t }] };
}

function fout(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
  };
}

interface Admin {
  admin_key: string;
  database_name: string;
  bedrijfsnaam: string | null;
  afgeschermd: boolean;
}

/**
 * Een administratie mag je aanwijzen met de volledige sleutel, het
 * databasenummer ("001") of een stuk van de bedrijfsnaam ("automaten").
 */
async function vindAdmin(pool: pg.Pool, wie: string, afgeschermdToestaan: boolean): Promise<Admin> {
  const { rows } = await pool.query<Admin>(
    `SELECT admin_key, database_name, bedrijfsnaam, afgeschermd FROM globe_admin ORDER BY admin_key`,
  );
  const w = wie.trim().toLowerCase();
  const kandidaten = rows.filter(
    (a) =>
      a.admin_key.toLowerCase() === w ||
      a.database_name.toLowerCase() === w ||
      (a.bedrijfsnaam ?? "").toLowerCase().includes(w),
  );
  if (kandidaten.length === 0) {
    throw new Error(
      `Geen administratie gevonden voor "${wie}". Beschikbaar: ` +
        rows.map((a) => `${a.database_name} (${a.bedrijfsnaam ?? "naam onbekend"})`).join(", "),
    );
  }
  if (kandidaten.length > 1) {
    throw new Error(
      `"${wie}" is niet eenduidig: ` + kandidaten.map((a) => `${a.database_name} (${a.bedrijfsnaam})`).join(", "),
    );
  }
  const a = kandidaten[0]!;
  if (a.afgeschermd && !afgeschermdToestaan) {
    throw new Error(
      `${a.bedrijfsnaam ?? a.database_name} is in het beheer afgeschermd. ` +
        `Alleen opvragen als Jan daar in dit gesprek uitdrukkelijk om vraagt; zet dan afgeschermd_bevestigd op true.`,
    );
  }
  return a;
}

const adminVeld = z
  .string()
  .min(1)
  .describe('Administratie: databasenummer ("001"), stuk van de bedrijfsnaam ("automaten") of volledige sleutel.');
const afgeschermdVeld = z
  .boolean()
  .default(false)
  .describe("Alleen true als de gebruiker uitdrukkelijk om een afgeschermde administratie vraagt.");

const LEES = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function registerTools(server: McpServer, pool: pg.Pool): void {
  server.registerTool(
    "globe_administraties",
    {
      title: "Globe-administraties en syncstatus",
      description: `Geeft de Exact Globe-administraties in de spiegel (Van Dungen Automaten, Drie D Holding, STAK Familiefonds, Van Dungen Pensioen), met per tabel het aantal rijen en wanneer de agent op de pc bij Automaten voor het laatst heeft gesynchroniseerd.

Roep dit als eerste aan. De spiegel is zo vers als de laatste sync: de pc staat niet altijd aan, dus noem de syncdatum als die ouder is dan een dag.`,
      inputSchema: {},
      annotations: LEES,
    },
    async () => {
      try {
        const { rows } = await pool.query(
          `SELECT a.database_name, a.bedrijfsnaam, a.afgeschermd, a.laatst_sync, a.admin_key,
                  (SELECT json_object_agg(s.tbl, json_build_object(
                     'rijen', (SELECT count(*) FROM globe_row r WHERE r.admin_key = s.admin_key AND r.tbl = s.tbl),
                     'bron', s.bron_aantal, 'strategie', s.strategie))
                     FROM globe_sync_state s WHERE s.admin_key = a.admin_key) AS tabellen
             FROM globe_admin a ORDER BY a.database_name`,
        );
        const run = await pool.query(
          `SELECT gestart, geeindigd, ok, host, versie, detail->'fouten' AS fouten
             FROM globe_run ORDER BY gestart DESC LIMIT 1`,
        );
        return tekst({ administraties: rows, laatste_run: run.rows[0] ?? null });
      } catch (e) {
        return fout(e);
      }
    },
  );

  server.registerTool(
    "globe_saldi",
    {
      title: "Saldi per grootboekrekening",
      description: `Telt de grootboekmutaties op per grootboekrekening voor één boekjaar, tot en met een periode.

Let op bij balansrekeningen: Globe boekt de beginbalans meestal als mutaties in periode 0 van het boekjaar; die tellen hier mee. Controleer bij twijfel met globe_mutaties.
Budgetregels en andere bijzondere transactiesoorten staan in transtype; standaard telt alles mee. Geef transtypes op om te filteren (bv. ["N"]).

Returns: per grootboek { grootboek, omschrijving, balans_of_wv, saldo, aantal }`,
      inputSchema: {
        administratie: adminVeld,
        boekjaar: z.number().int().min(1990).max(2100),
        tot_periode: z.number().int().min(0).max(99).default(99),
        transtypes: z.array(z.string().max(2)).optional(),
        afgeschermd_bevestigd: afgeschermdVeld,
      },
      annotations: LEES,
    },
    async (a) => {
      try {
        const adm = await vindAdmin(pool, a.administratie, a.afgeschermd_bevestigd);
        const { rows } = await pool.query(
          `SELECT m.grootboek,
                  max(g.omschrijving) AS omschrijving,
                  max(g.balans_of_wv) AS balans_of_wv,
                  round(sum(m.bedrag), 2) AS saldo,
                  count(*) AS aantal
             FROM v_grootboekmutaties m
             LEFT JOIN v_grootboekrekeningen g ON g.admin_key = m.admin_key AND g.grootboek = m.grootboek
            WHERE m.admin_key = $1 AND m.boekjaar = $2 AND m.periode <= $3
              AND ($4::text[] IS NULL OR m.transtype = ANY($4))
            GROUP BY m.grootboek
            ORDER BY m.grootboek`,
          [adm.admin_key, a.boekjaar, a.tot_periode, a.transtypes ?? null],
        );
        return tekst({ administratie: adm.bedrijfsnaam ?? adm.database_name, boekjaar: a.boekjaar, tot_periode: a.tot_periode, saldi: rows });
      } catch (e) {
        return fout(e);
      }
    },
  );

  server.registerTool(
    "globe_mutaties",
    {
      title: "Grootboekmutaties zoeken",
      description: `Zoekt grootboekmutaties in één administratie. Alle filters zijn optioneel en worden gecombineerd.

- grootboek: exact rekeningnummer
- relatie: debiteur- of crediteurnummer
- zoek: tekst in de omschrijving (hoofdletterongevoelig)
- van / tot: datum (JJJJ-MM-DD)

Returns: mutaties nieuwste eerst, maximaal 'limiet'.`,
      inputSchema: {
        administratie: adminVeld,
        grootboek: z.string().max(20).optional(),
        relatie: z.string().max(20).optional(),
        zoek: z.string().max(100).optional(),
        van: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        tot: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        limiet: z.number().int().min(1).max(1000).default(100),
        afgeschermd_bevestigd: afgeschermdVeld,
      },
      annotations: LEES,
    },
    async (a) => {
      try {
        const adm = await vindAdmin(pool, a.administratie, a.afgeschermd_bevestigd);
        const { rows } = await pool.query(
          `SELECT boekjaar, periode, datum, dagboek, boekstuk, grootboek, omschrijving, bedrag,
                  debiteur, crediteur, factuurnr, kostenplaats, btw_code, transtype
             FROM v_grootboekmutaties
            WHERE admin_key = $1
              AND ($2::text IS NULL OR grootboek = $2)
              AND ($3::text IS NULL OR debiteur = $3 OR crediteur = $3)
              AND ($4::text IS NULL OR omschrijving ILIKE '%' || $4 || '%')
              AND ($5::date IS NULL OR datum >= $5)
              AND ($6::date IS NULL OR datum <= $6)
            ORDER BY datum DESC NULLS LAST, boekstuk DESC
            LIMIT $7`,
          [adm.admin_key, a.grootboek ?? null, a.relatie ?? null, a.zoek ?? null, a.van ?? null, a.tot ?? null, a.limiet],
        );
        return tekst({ administratie: adm.bedrijfsnaam ?? adm.database_name, aantal: rows.length, mutaties: rows });
      } catch (e) {
        return fout(e);
      }
    },
  );

  server.registerTool(
    "globe_relaties",
    {
      title: "Relaties zoeken",
      description: `Zoekt debiteuren en crediteuren (Globe-tabel cicmpy) op naam, code of nummer.`,
      inputSchema: {
        administratie: adminVeld,
        zoek: z.string().min(1).max(100),
        limiet: z.number().int().min(1).max(200).default(25),
        afgeschermd_bevestigd: afgeschermdVeld,
      },
      annotations: LEES,
    },
    async (a) => {
      try {
        const adm = await vindAdmin(pool, a.administratie, a.afgeschermd_bevestigd);
        const { rows } = await pool.query(
          `SELECT code, naam, debiteur, crediteur, soort,
                  data->>'cmp_fadd1' AS adres, data->>'cmp_fcity' AS plaats
             FROM v_relaties
            WHERE admin_key = $1
              AND (naam ILIKE '%' || $2 || '%' OR code ILIKE '%' || $2 || '%' OR debiteur = $2 OR crediteur = $2)
            ORDER BY naam LIMIT $3`,
          [adm.admin_key, a.zoek, a.limiet],
        );
        return tekst({ administratie: adm.bedrijfsnaam ?? adm.database_name, relaties: rows });
      } catch (e) {
        return fout(e);
      }
    },
  );

  server.registerTool(
    "globe_sql",
    {
      title: "Vrije SQL op de spiegel (alleen lezen)",
      description: `Voert één SELECT uit op de Postgres-spiegel, in een READ ONLY-transactie met een tijdslimiet van 20 seconden en maximaal 500 rijen.

Beschikbaar:
- v_grootboekmutaties (admin_key, bedrijfsnaam, afgeschermd, boekjaar, periode, dagboek, boekstuk, grootboek, datum, omschrijving, bedrag, debiteur, crediteur, factuurnr, kostenplaats, btw_code, transtype, gebruiker (Globe syscreator), geboekt_op (syscreated))
- v_grootboekrekeningen (admin_key, bedrijfsnaam, grootboek, omschrijving, balans_of_wv, debet_credit, data)
- v_relaties (admin_key, bedrijfsnaam, id, code, naam, debiteur, crediteur, soort, data)
- globe_row (admin_key, tbl, pk, data jsonb) — elke gespiegelde Globe-tabel, kolommen als data->>'kolom'
- globe_sync_state (per tabel: kolommen, sleutel, watermerk), globe_admin

Kolomnamen in data zijn de originele Globe-kolommen in kleine letters. Bekijk globe_sync_state.kolommen als je niet weet welke er zijn.
Deze tool ziet ook afgeschermde administraties; filter op afgeschermd = false tenzij de gebruiker er uitdrukkelijk om vraagt.`,
      inputSchema: { sql: z.string().min(1).max(10_000) },
      annotations: LEES,
    },
    async ({ sql }) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SET LOCAL statement_timeout = '20s'");
        const res = await client.query({ text: `SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS q LIMIT 500` });
        await client.query("ROLLBACK");
        return tekst({ rijen: res.rowCount, data: res.rows });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        return fout(e);
      } finally {
        client.release();
      }
    },
  );
}
