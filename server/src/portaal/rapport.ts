import type pg from "pg";

/**
 * Query's achter de inzichtschermen. Alles leest uit de spiegel; niets hier
 * raakt Globe.
 *
 * Teken: Globe boekt debet positief en credit negatief (bdr_hfl). Een
 * opbrengst staat dus negatief in de mutaties; voor het resultaat draaien we
 * het teken om, zodat winst positief leest.
 */

/** Grootboekrekeningen waarvan regels persoonsgegevens kunnen bevatten. */
export const LOON_REKENING = "(loon|lonen|salaris|salarissen|sociale lasten|loonheffing|pensioenpremie|vakantiegeld|personeelskosten|bruto|netto ?loon)";
/** Tabellen met personeels- en loongegevens. */
export const LOON_TABEL = /^(humres|hr|hrm|loon|lon_|salar|sal_|pay|prl|emp|absen|verlof|ziek|pers|wage|ctr|contract)/i;

/** SQL-filter op een alias met grootboek-omschrijving `go` (uit grtbk). */
const zonderLonen = (lonen: boolean, alias = "go") =>
  lonen ? "TRUE" : `NOT (COALESCE(${alias}, '') ~* '${LOON_REKENING}')`;

/**
 * SQL-voorwaarde: de rij (uit globe_row, alias r) is géén gbkmut-regel op een
 * loonrekening. Voor de ruwe tabelweergave en de wijzigingenlijst, waar geen
 * getypeerde join beschikbaar is. `veld` wijst naar de JSON met reknr.
 */
export const geenLoonRegel = (lonen: boolean, alias: string, veld: string) =>
  lonen
    ? "TRUE"
    : `NOT (${alias}.tbl = 'gbkmut' AND EXISTS (
         SELECT 1 FROM gb_mutatie lx
           JOIN globe_row lr ON lr.admin_key = lx.admin_key AND lr.tbl = 'grtbk' AND trim(lr.data->>'reknr') = lx.grootboek
          WHERE lx.admin_key = ${alias}.admin_key
            AND lx.dagboek = nullif(trim(${veld}->>'dagbknr'), '') AND lx.boekstuk = nullif(trim(${veld}->>'bkstnr'), '')
            AND COALESCE(lr.data->>'oms25_0', '') ~* '${LOON_REKENING}'))
      AND NOT (${alias}.tbl = 'gbkmut' AND EXISTS (
         SELECT 1 FROM globe_row lr WHERE lr.admin_key = ${alias}.admin_key AND lr.tbl = 'grtbk'
            AND trim(lr.data->>'reknr') = trim(${veld}->>'reknr')
            AND COALESCE(lr.data->>'oms25_0', '') ~* '${LOON_REKENING}'))
      AND NOT (${alias}.tbl = 'gbkmut' AND COALESCE(${veld}->>'oms25', '') ~* '${LOON_REKENING}')`;

/** Boekstuk (alias m, uit gb_mutatie) zonder regels op loonrekeningen. */
export const geenLoonBoekstuk = (lonen: boolean, m: string) =>
  lonen
    ? "TRUE"
    : `NOT EXISTS (SELECT 1 FROM gb_mutatie lx JOIN globe_row lr ON lr.admin_key = lx.admin_key AND lr.tbl = 'grtbk' AND trim(lr.data->>'reknr') = lx.grootboek
                    WHERE lx.admin_key = ${m}.admin_key AND lx.dagboek = ${m}.dagboek AND lx.boekstuk = ${m}.boekstuk
                      AND COALESCE(lr.data->>'oms25_0', '') ~* '${LOON_REKENING}')`;

export interface RekeningInfo {
  grootboek: string;
  omschrijving: string | null;
  bal_vw: string | null;
}

export class Rapport {
  constructor(private readonly pool: pg.Pool) {}

  async boekjaren(admin: string): Promise<number[]> {
    const r = await this.pool.query<{ boekjaar: number }>(
      `SELECT DISTINCT boekjaar FROM gb_mutatie WHERE admin_key = $1 AND boekjaar IS NOT NULL ORDER BY boekjaar DESC`,
      [admin],
    );
    return r.rows.map((x) => x.boekjaar);
  }

  async rekeningen(admin: string): Promise<Map<string, RekeningInfo>> {
    const r = await this.pool.query<RekeningInfo>(
      `SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS omschrijving, upper(trim(data->>'bal_vw')) AS bal_vw
         FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk'`,
      [admin],
    );
    return new Map(r.rows.map((x) => [x.grootboek, x]));
  }

  /** Kerncijfers voor het overzicht van één administratie. */
  async kerncijfers(admin: string, jaar: number) {
    const r = await this.pool.query(
      `WITH rek AS (
         SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS oms, upper(trim(data->>'bal_vw')) AS bal_vw
           FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk')
       SELECT
         -sum(m.bedrag) FILTER (WHERE rek.bal_vw = 'W')                                   AS resultaat,
         -sum(m.bedrag) FILTER (WHERE rek.bal_vw = 'W' AND m.bedrag < 0)                  AS opbrengsten,
          sum(m.bedrag) FILTER (WHERE rek.bal_vw = 'W' AND m.bedrag > 0)                  AS kosten,
         count(*)                                                                         AS regels,
         count(DISTINCT (m.dagboek, m.boekstuk))                                          AS boekstukken,
         max(m.datum)                                                                     AS laatste_datum
         FROM gb_mutatie m LEFT JOIN rek ON rek.grootboek = m.grootboek
        WHERE m.admin_key = $1 AND m.boekjaar = $2`,
      [admin, jaar],
    );
    const liquide = await this.pool.query(
      `WITH rek AS (
         SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS oms
           FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk'
          WHERE_PLACEHOLDER)
       SELECT rek.grootboek, rek.oms, sum(m.bedrag) AS saldo
         FROM rek JOIN gb_mutatie m ON m.admin_key = $1 AND m.grootboek = rek.grootboek
        WHERE ${this.saldoFilter("m")}
        GROUP BY rek.grootboek, rek.oms ORDER BY rek.grootboek`.replace(
        "WHERE_PLACEHOLDER",
        "AND upper(trim(data->>'bal_vw')) = 'B' AND data->>'oms25_0' ~* '(bank|\\mkas\\M|kasgeld|rabo|\\ming\\M|abn|knab|triodos|spaar|deposito|giro)'",
      ),
      [admin, jaar],
    );
    return { ...r.rows[0], liquide: liquide.rows };
  }

  /**
   * Voorwaarde voor een balanssaldo per einde boekjaar $2.
   *
   * Globe kan de beginbalans als boekingen in periode 0 van elk jaar vastleggen;
   * dan telt alleen het boekjaar zelf. Staat er geen periode 0 in dat jaar, dan
   * is het saldo de som over alle jaren tot en met dit jaar.
   */
  private saldoFilter(m: string): string {
    return `(CASE WHEN EXISTS (SELECT 1 FROM gb_mutatie p WHERE p.admin_key = $1 AND p.boekjaar = $2 AND p.periode = 0)
                  THEN ${m}.boekjaar = $2 ELSE ${m}.boekjaar <= $2 END)`;
  }

  async heeftBeginbalans(admin: string, jaar: number): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM gb_mutatie WHERE admin_key = $1 AND boekjaar = $2 AND periode = 0 LIMIT 1`, [admin, jaar]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Balans per einde periode, met vergelijking vorig boekjaar. */
  async balans(admin: string, jaar: number, totPeriode: number) {
    const begin = await this.heeftBeginbalans(admin, jaar);
    const r = await this.pool.query(
      `WITH rek AS (
         SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS oms, upper(trim(data->>'bal_vw')) AS bal_vw
           FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk')
       SELECT m.grootboek, max(rek.oms) AS omschrijving, max(rek.bal_vw) AS bal_vw,
              sum(m.bedrag) FILTER (WHERE ${begin ? "m.boekjaar = $2" : "m.boekjaar <= $2"} AND (m.boekjaar < $2 OR m.periode <= $3)) AS saldo,
              sum(m.bedrag) FILTER (WHERE ${begin ? "m.boekjaar = $2 - 1" : "m.boekjaar <= $2 - 1"}) AS vorig
         FROM gb_mutatie m LEFT JOIN rek ON rek.grootboek = m.grootboek
        WHERE m.admin_key = $1 AND m.boekjaar <= $2
        GROUP BY m.grootboek
        ORDER BY m.grootboek`,
      [admin, jaar, totPeriode],
    );
    return { methode: begin ? "beginbalans" : "cumulatief", rijen: r.rows };
  }

  /** Winst-en-verliesrekening per periode, met vorig jaar. */
  async resultaat(admin: string, jaar: number) {
    const r = await this.pool.query(
      `WITH rek AS (
         SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS oms, upper(trim(data->>'bal_vw')) AS bal_vw
           FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk')
       SELECT m.grootboek, max(rek.oms) AS omschrijving,
              jsonb_object_agg(m.periode, m.som) FILTER (WHERE m.boekjaar = $2) AS per_periode,
              sum(m.som) FILTER (WHERE m.boekjaar = $2) AS totaal,
              sum(m.som) FILTER (WHERE m.boekjaar = $2 - 1) AS vorig
         FROM (SELECT grootboek, boekjaar, periode, -sum(bedrag) AS som
                 FROM gb_mutatie WHERE admin_key = $1 AND boekjaar IN ($2, $2 - 1)
                GROUP BY grootboek, boekjaar, periode) m
         LEFT JOIN rek ON rek.grootboek = m.grootboek
        WHERE COALESCE(rek.bal_vw, 'W') = 'W'
        GROUP BY m.grootboek
        ORDER BY m.grootboek`,
      [admin, jaar],
    );
    const perioden = await this.pool.query<{ periode: number }>(
      `SELECT DISTINCT periode FROM gb_mutatie WHERE admin_key = $1 AND boekjaar = $2 ORDER BY periode`,
      [admin, jaar],
    );
    return { perioden: perioden.rows.map((p) => p.periode), rijen: r.rows };
  }

  /** Mutaties met filters. Regels op loonrekeningen alleen voor wie lonen mag zien. */
  async mutaties(
    admin: string,
    f: { grootboek?: string; relatie?: string; zoek?: string; van?: string; tot?: string; jaar?: number; dagboek?: string; boekstuk?: string; gebruiker?: string },
    lonen: boolean,
    limiet: number,
    offset: number,
  ) {
    const r = await this.pool.query(
      `WITH rek AS (
         SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS go
           FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk')
       SELECT m.pk, m.boekjaar, m.periode, m.datum, m.dagboek, m.boekstuk, m.grootboek, rek.go AS rekening,
              m.omschrijving, m.bedrag, m.debiteur, m.crediteur, m.factuurnr, m.kostenplaats, m.btw_code, m.gebruiker,
              count(*) OVER () AS totaal_aantal, sum(m.bedrag) OVER () AS totaal_bedrag
         FROM gb_mutatie m LEFT JOIN rek ON rek.grootboek = m.grootboek
        WHERE m.admin_key = $1
          AND ($2::text IS NULL OR m.grootboek = $2)
          AND ($3::text IS NULL OR m.debiteur = $3 OR m.crediteur = $3)
          AND ($4::text IS NULL OR m.omschrijving ILIKE '%' || $4 || '%' OR m.factuurnr ILIKE '%' || $4 || '%' OR m.boekstuk = $4)
          AND ($5::date IS NULL OR m.datum >= $5)
          AND ($6::date IS NULL OR m.datum <= $6)
          AND ($7::int IS NULL OR m.boekjaar = $7)
          AND ($8::text IS NULL OR m.dagboek = $8)
          AND ($9::text IS NULL OR m.boekstuk = $9)
          AND ($10::text IS NULL OR m.gebruiker = $10)
          AND ${zonderLonen(lonen, "rek.go")} AND ${geenLoonBoekstuk(lonen, "m")}
        ORDER BY m.datum DESC NULLS LAST, m.dagboek, m.boekstuk, m.pk
        LIMIT $11 OFFSET $12`,
      [admin, f.grootboek ?? null, f.relatie ?? null, f.zoek ?? null, f.van ?? null, f.tot ?? null, f.jaar ?? null, f.dagboek ?? null, f.boekstuk ?? null, f.gebruiker ?? null, limiet, offset],
    );
    return {
      rijen: r.rows,
      aantal: Number(r.rows[0]?.totaal_aantal ?? 0),
      som: Number(r.rows[0]?.totaal_bedrag ?? 0),
    };
  }

  /** Grootboekkaart: beginsaldo plus mutaties van het jaar met lopend saldo. */
  async grootboekkaart(admin: string, rek: string, jaar: number, lonen = true) {
    const begin = await this.heeftBeginbalans(admin, jaar);
    const start = await this.pool.query<{ s: string | null }>(
      `SELECT sum(bedrag) AS s FROM gb_mutatie WHERE admin_key = $1 AND grootboek = $2 AND ${begin ? "boekjaar = $3 AND periode = 0" : "boekjaar < $3"}`,
      [admin, rek, jaar],
    );
    const r = await this.pool.query(
      `SELECT m.pk, m.periode, m.datum, m.dagboek, m.boekstuk, m.omschrijving, m.bedrag, m.debiteur, m.crediteur, m.factuurnr, m.gebruiker,
              NOT (${geenLoonBoekstuk(lonen, "m")}) AS verborgen,
              sum(m.bedrag) OVER (ORDER BY m.datum NULLS FIRST, m.dagboek, m.boekstuk, m.pk) AS lopend
         FROM gb_mutatie m WHERE m.admin_key = $1 AND m.grootboek = $2 AND m.boekjaar = $3 ${begin ? "AND m.periode <> 0" : ""}
        ORDER BY m.datum NULLS FIRST, m.dagboek, m.boekstuk, m.pk`,
      [admin, rek, jaar],
    );
    // Zonder lonen-recht: loonboekingen per periode samenvatten. Het lopende
    // saldo blijft kloppen, maar geen enkele betaling is herleidbaar.
    const rijen: any[] = [];
    for (const x of r.rows as any[]) {
      if (!x.verborgen) {
        rijen.push(x);
        continue;
      }
      const vorige = rijen[rijen.length - 1];
      if (vorige?.samengevat && vorige.periode === x.periode) {
        vorige.bedrag = Number(vorige.bedrag) + Number(x.bedrag);
        vorige.lopend = x.lopend;
        vorige.datum = x.datum;
      } else {
        rijen.push({ samengevat: true, periode: x.periode, datum: x.datum, omschrijving: "Loonboekingen (samengevat)", bedrag: Number(x.bedrag), lopend: x.lopend });
      }
    }
    return { beginsaldo: Number(start.rows[0]?.s ?? 0), rijen };
  }

  /** Eén boekstuk, alle regels. */
  async boekstuk(admin: string, dagboek: string, boekstuk: string) {
    const r = await this.pool.query(
      `WITH rek AS (SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS go FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk')
       SELECT m.*, rek.go AS rekening, r.eerst_gezien, r.versies
         FROM gb_mutatie m
         LEFT JOIN rek ON rek.grootboek = m.grootboek
         LEFT JOIN globe_row r ON r.admin_key = m.admin_key AND r.tbl = 'gbkmut' AND r.pk = m.pk
        WHERE m.admin_key = $1 AND m.dagboek = $2 AND m.boekstuk = $3
        ORDER BY m.pk`,
      [admin, dagboek, boekstuk],
    );
    const hist = await this.pool.query(
      `SELECT h.* FROM globe_row_historie h
        WHERE h.admin_key = $1 AND h.tbl = 'gbkmut'
          AND trim(COALESCE(h.data_oud->>'dagbknr', '')) = $2 AND trim(COALESCE(h.data_oud->>'bkstnr', '')) = $3
        ORDER BY h.gemerkt_op DESC`,
      [admin, dagboek, boekstuk],
    );
    return { regels: r.rows, historie: hist.rows };
  }

  async relaties(admin: string, zoek: string | null, limiet = 200) {
    const r = await this.pool.query(
      `SELECT trim(data->>'cmp_code') AS code, data->>'cmp_name' AS naam,
              nullif(trim(data->>'debnr'), '') AS debiteur, nullif(trim(data->>'crdnr'), '') AS crediteur,
              data->>'cmp_fcity' AS plaats,
              (SELECT sum(bedrag) FROM gb_mutatie m WHERE m.admin_key = $1
                  AND (m.debiteur = nullif(trim(r.data->>'debnr'), '') OR m.crediteur = nullif(trim(r.data->>'crdnr'), ''))) AS omzet_som
         FROM globe_row r
        WHERE admin_key = $1 AND tbl = 'cicmpy'
          AND (nullif(trim(data->>'debnr'), '') IS NOT NULL OR nullif(trim(data->>'crdnr'), '') IS NOT NULL)
          AND ($2::text IS NULL OR data->>'cmp_name' ILIKE '%' || $2 || '%' OR data->>'cmp_code' ILIKE '%' || $2 || '%'
               OR trim(data->>'debnr') = $2 OR trim(data->>'crdnr') = $2)
        ORDER BY data->>'cmp_name' LIMIT $3`,
      [admin, zoek, limiet],
    );
    return r.rows;
  }

  /** Wie in Globe boekt: syscreator vertaald via humres. */
  async gebruikers(admin: string, jaar: number) {
    const r = await this.pool.query(
      `SELECT m.gebruiker, max(h.data->>'fullname') AS naam, count(*) AS regels,
              count(DISTINCT (m.dagboek, m.boekstuk)) AS boekstukken,
              min(m.datum) AS eerste, max(m.datum) AS laatste
         FROM gb_mutatie m
         LEFT JOIN globe_row h ON h.admin_key = m.admin_key AND h.tbl = 'humres' AND trim(h.data->>'res_id') = m.gebruiker
        WHERE m.admin_key = $1 AND m.boekjaar = $2
        GROUP BY m.gebruiker ORDER BY regels DESC`,
      [admin, jaar],
    );
    return r.rows;
  }

  /** Wat er recent bij is gekomen of veranderd, voor "wat gebeurt er". */
  async recent(admin: string, dagen: number, lonen: boolean) {
    const nieuw = await this.pool.query(
      `WITH rek AS (SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS go FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk')
       SELECT date_trunc('day', r.eerst_gezien) AS dag, m.dagboek, count(*) AS regels,
              count(DISTINCT m.boekstuk) AS boekstukken, sum(abs(m.bedrag)) / 2 AS omvang
         FROM globe_row r
         JOIN globe_sync_state s ON s.admin_key = r.admin_key AND s.tbl = r.tbl
         JOIN gb_mutatie m ON m.admin_key = r.admin_key AND m.pk = r.pk
         LEFT JOIN rek ON rek.grootboek = m.grootboek
        WHERE r.admin_key = $1 AND r.tbl = 'gbkmut'
          AND s.initieel_klaar IS NOT NULL AND r.eerst_gezien > s.initieel_klaar
          AND r.eerst_gezien > now() - make_interval(days => $2)
          AND ${zonderLonen(lonen, "rek.go")} AND ${geenLoonBoekstuk(lonen, "m")}
        GROUP BY 1, 2 ORDER BY 1 DESC, 2`,
      [admin, dagen],
    );
    const wijz = await this.pool.query(
      `SELECT tbl, soort, count(*) AS n, max(gemerkt_op) AS laatst
         FROM globe_row_historie WHERE admin_key = $1 AND gemerkt_op > now() - make_interval(days => $2)
        GROUP BY tbl, soort ORDER BY n DESC`,
      [admin, dagen],
    );
    return { nieuw: nieuw.rows, wijzigingen: wijz.rows };
  }

  /** Achteraf gewijzigde of verwijderde rijen, met de oude en nieuwe versie. */
  async wijzigingen(admin: string, tbl: string | null, soort: string | null, lonen: boolean, limiet: number, offset: number) {
    const r = await this.pool.query(
      `SELECT id, tbl, pk, soort, data_oud, data_nieuw, gemerkt_op, count(*) OVER () AS totaal
         FROM globe_row_historie
        WHERE admin_key = $1 AND ($2::text IS NULL OR tbl = $2) AND ($3::text IS NULL OR soort = $3)
          AND ($4 OR NOT (tbl ~* $5))
          AND ${geenLoonRegel(lonen, "globe_row_historie", "globe_row_historie.data_oud")}
        ORDER BY gemerkt_op DESC, id DESC LIMIT $6 OFFSET $7`,
      [admin, tbl, soort, lonen, LOON_TABEL.source, limiet, offset],
    );
    return { rijen: r.rows, aantal: Number(r.rows[0]?.totaal ?? 0) };
  }

  /** Alle gespiegelde tabellen van een administratie. */
  async tabellen(admin: string) {
    const r = await this.pool.query(
      `SELECT s.tbl, s.strategie, s.bron_aantal, s.laatst_rijen, jsonb_array_length(COALESCE(s.kolommen, '[]')) AS kolommen,
              (SELECT count(*) FROM globe_row r WHERE r.admin_key = s.admin_key AND r.tbl = s.tbl) AS rijen
         FROM globe_sync_state s WHERE s.admin_key = $1 ORDER BY s.tbl`,
      [admin],
    );
    return r.rows;
  }

  async tabel(admin: string, tbl: string, zoek: string | null, sorteer: string | null, limiet: number, offset: number, lonen: boolean) {
    const st = await this.pool.query<{ kolommen: string[]; sleutel: string[] }>(
      `SELECT kolommen, sleutel FROM globe_sync_state WHERE admin_key = $1 AND tbl = $2`,
      [admin, tbl],
    );
    const kolommen = (st.rows[0]?.kolommen ?? []).map((k) => k.toLowerCase());
    const sk = sorteer && kolommen.includes(sorteer.replace(/^-/, "")) ? sorteer : null;
    const orde = sk ? `data->>'${sk.replace(/^-/, "").replace(/'/g, "")}' ${sk.startsWith("-") ? "DESC" : "ASC"} NULLS LAST, pk` : "pk";
    const r = await this.pool.query(
      `SELECT pk, data, eerst_gezien, versies, count(*) OVER () AS totaal
         FROM globe_row r WHERE admin_key = $1 AND tbl = $2
          AND ($3::text IS NULL OR data::text ILIKE '%' || $3 || '%')
          AND ${geenLoonRegel(lonen, "r", "r.data")}
        ORDER BY ${orde} LIMIT $4 OFFSET $5`,
      [admin, tbl, zoek, limiet, offset],
    );
    // Kolommen die in de data staan maar (nog) niet in de aanmelding: ook tonen.
    for (const rij of r.rows) for (const k of Object.keys(rij.data ?? {})) if (!kolommen.includes(k)) kolommen.push(k);
    return { kolommen, rijen: r.rows, aantal: Number(r.rows[0]?.totaal ?? 0) };
  }

  async sync(admin: string | null) {
    const runs = await this.pool.query(
      `SELECT id, host, versie, gestart, geeindigd, ok, detail FROM globe_run ORDER BY gestart DESC LIMIT 25`,
    );
    const tabellen = admin
      ? await this.pool.query(
          `SELECT tbl, strategie, bron_aantal, laatst_rijen, laatst_sleutelscan, initieel_klaar,
                  (SELECT count(*) FROM globe_row r WHERE r.admin_key = s.admin_key AND r.tbl = s.tbl) AS spiegel
             FROM globe_sync_state s WHERE admin_key = $1 ORDER BY tbl`,
          [admin],
        )
      : { rows: [] };
    return { runs: runs.rows, tabellen: tabellen.rows };
  }
}

/* ───────────────────────────── aansluiting en onderlinge verhoudingen ── */

/**
 * Trefwoord waarmee een administratie in de rekeningnamen van een andere
 * administratie herkend wordt: de bedrijfsnaam zonder rechtsvorm en
 * familienaam. "Van Dungen Automaten B.V." → "automaten", "De Drie D Holding
 * B.V." → "drie d", "Stichting Administratiekantoor Familiefonds Van den
 * Dungen" → "familiefonds".
 */
export function trefwoord(bedrijfsnaam: string | null): string | null {
  if (!bedrijfsnaam) return null;
  const rest = bedrijfsnaam
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["b", "v", "bv", "nv", "n", "van", "den", "der", "dungen", "de", "stichting", "administratiekantoor", "holding", "beheer"].includes(w));
  return rest.length ? rest.join(" ") : null;
}

const RC = "(r/?c|rek(ening)?[ .-]*cour|groep|deelnem|lening|vordering|schuld)";

export interface AansluitRegel {
  post: string;
  label: string;
  spiegel: number | null;
  jaarrekening: number;
  verschil: number | null;
  noot: string;
}

export interface OnderlingPaar {
  a: { admin_key: string; naam: string; rekening: string; omschrijving: string; saldo: number }[];
  b: { admin_key: string; naam: string; rekening: string; omschrijving: string; saldo: number }[];
  naamA: string;
  naamB: string;
  somA: number;
  somB: number;
  verschil: number;
  refA: number | null;
  refB: number | null;
}

export class Aansluiting {
  constructor(private readonly pool: pg.Pool) {}

  /** Saldo per balansrekening eind boekjaar, met dezelfde beginbalansmethode als het balansscherm. */
  private async balansSaldi(admin: string, jaar: number) {
    const r = await this.pool.query<{ grootboek: string; oms: string | null; bal_vw: string | null; saldo: string }>(
      `WITH rek AS (SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS oms, upper(trim(data->>'bal_vw')) AS bal_vw
                      FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk'),
            begin AS (SELECT EXISTS (SELECT 1 FROM gb_mutatie WHERE admin_key = $1 AND boekjaar = $2 AND periode = 0) AS ja)
       SELECT m.grootboek, max(rek.oms) AS oms, max(rek.bal_vw) AS bal_vw, sum(m.bedrag) AS saldo
         FROM gb_mutatie m LEFT JOIN rek ON rek.grootboek = m.grootboek
        WHERE m.admin_key = $1
          AND CASE WHEN (SELECT ja FROM begin) THEN m.boekjaar = $2 ELSE m.boekjaar <= $2 END
        GROUP BY m.grootboek`,
      [admin, jaar],
    );
    return r.rows.map((x) => ({ ...x, saldo: Number(x.saldo) }));
  }

  async regels(admin: string, bedrijfsnaam: string | null, jaar: number): Promise<{ regels: AansluitRegel[]; bron: string | null }> {
    const ref = await this.pool.query<{ post: string; bedrag: string; bron: string | null }>(
      `SELECT post, bedrag, bron FROM jaarrekening_ref WHERE jaar = $2 AND $1 ILIKE '%' || bedrijf || '%' AND post NOT LIKE 'rc:%'`,
      [bedrijfsnaam ?? "", jaar],
    );
    if (ref.rowCount === 0) return { regels: [], bron: null };
    const s = await this.balansSaldi(admin, jaar);
    const balans = s.filter((x) => (x.bal_vw ?? "B") === "B");
    const wv = s.filter((x) => x.bal_vw === "W");
    // Resultaat van dit boekjaar alleen (W-rekeningen van $2).
    const res = await this.pool.query<{ r: string | null }>(
      `WITH rek AS (SELECT trim(data->>'reknr') AS grootboek, upper(trim(data->>'bal_vw')) AS bal_vw FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk')
       SELECT -sum(m.bedrag) AS r FROM gb_mutatie m JOIN rek ON rek.grootboek = m.grootboek AND rek.bal_vw = 'W'
        WHERE m.admin_key = $1 AND m.boekjaar = $2`,
      [admin, jaar],
    );
    const heeftData = s.length > 0;
    const resultaat = heeftData ? Number(res.rows[0]?.r ?? 0) : null;
    const activa = heeftData ? balans.filter((x) => x.saldo > 0).reduce((t, x) => t + x.saldo, 0) : null;
    const liquide = heeftData
      ? balans.filter((x) => /(bank|\bkas\b|kasgeld|rabo|\bing\b|abn|knab|triodos|spaar|deposito|giro|kruispost|van lanschot)/i.test(x.oms ?? "")).reduce((t, x) => t + x.saldo, 0)
      : null;
    // Eigen vermogen na resultaatbestemming: kapitaal en reserves plus het (nog niet verdeelde) resultaat.
    const ev = heeftData
      ? -balans.filter((x) => /(kapitaal|reserve|eigen vermogen|agio|winst ?saldo|onverdeeld)/i.test(x.oms ?? "")).reduce((t, x) => t + x.saldo, 0) -
        wv.reduce((t, x) => t + x.saldo, 0)
      : null;
    const spiegel: Record<string, number | null> = { resultaat, activa, liquide, eigen_vermogen: ev };
    const LABEL: Record<string, [string, string]> = {
      resultaat: ["Resultaat na belastingen", "Verschil kan komen van boekingen die de accountant buiten Globe maakt (vennootschapsbelasting, resultaat deelnemingen, afschrijvingen)."],
      activa: ["Totaal activa", "Spiegel: som van de balansrekeningen met een debetsaldo. Verrekening van rekeningen met een creditsaldo in de jaarrekening geeft verschil."],
      liquide: ["Liquide middelen", "Spiegel: rekeningen met bank, kas, spaar, kruisposten en dergelijke in de naam."],
      eigen_vermogen: ["Eigen vermogen", "Spiegel: kapitaal en reserves plus het nog niet verdeelde resultaat."],
      omzet: ["Netto-omzet", "Niet automatisch te bepalen zonder rubricering; alleen ter referentie."],
    };
    const regels = ref.rows.map((x) => {
      const j = Number(x.bedrag);
      const sp = x.post in spiegel ? spiegel[x.post]! : null;
      return {
        post: x.post,
        label: LABEL[x.post]?.[0] ?? x.post,
        spiegel: sp,
        jaarrekening: j,
        verschil: sp === null ? null : Math.round((sp - j) * 100) / 100,
        noot: LABEL[x.post]?.[1] ?? "",
      };
    });
    const volgorde = ["resultaat", "eigen_vermogen", "activa", "liquide", "omzet"];
    regels.sort((a, b) => volgorde.indexOf(a.post) - volgorde.indexOf(b.post));
    return { regels, bron: ref.rows[0]?.bron ?? null };
  }

  /**
   * Rekening-courantposities tussen administraties. In administratie A zoeken
   * we rekeningen waarvan de naam het trefwoord van B bevat en die op een
   * vordering of schuld lijken, en omgekeerd. Samen horen ze nul te zijn.
   */
  async onderling(admins: Array<{ admin_key: string; bedrijfsnaam: string | null; database_name: string }>, jaar: number): Promise<OnderlingPaar[]> {
    const saldi = new Map<string, Awaited<ReturnType<Aansluiting["balansSaldi"]>>>();
    for (const a of admins) saldi.set(a.admin_key, await this.balansSaldi(a.admin_key, jaar));
    const naam = (a: (typeof admins)[number]) => a.bedrijfsnaam ?? `Administratie ${a.database_name}`;
    const refs = (await this.pool.query<{ bedrijf: string; post: string; bedrag: string }>(`SELECT bedrijf, post, bedrag FROM jaarrekening_ref WHERE jaar = $1 AND post LIKE 'rc:%'`, [jaar])).rows;
    const ref = (a: (typeof admins)[number], b: (typeof admins)[number]) => {
      const tb = trefwoord(b.bedrijfsnaam);
      const r = refs.find((x) => (a.bedrijfsnaam ?? "").toLowerCase().includes(x.bedrijf.toLowerCase()) && tb && x.post === `rc:${tb}`);
      return r ? Number(r.bedrag) : null;
    };
    const uit: OnderlingPaar[] = [];
    for (let i = 0; i < admins.length; i++) {
      for (let j = i + 1; j < admins.length; j++) {
        const A = admins[i]!;
        const B = admins[j]!;
        const ta = trefwoord(A.bedrijfsnaam);
        const tb = trefwoord(B.bedrijfsnaam);
        if (!ta || !tb) continue;
        const zoek = (in_: (typeof admins)[number], woord: string) =>
          (saldi.get(in_.admin_key) ?? [])
            .filter((x) => (x.bal_vw ?? "B") === "B" && (x.oms ?? "").toLowerCase().includes(woord) && new RegExp(RC, "i").test(x.oms ?? ""))
            .map((x) => ({ admin_key: in_.admin_key, naam: naam(in_), rekening: x.grootboek, omschrijving: x.oms ?? "", saldo: Math.round(x.saldo * 100) / 100 }));
        const a = zoek(A, tb);
        const b = zoek(B, ta);
        const refA = ref(A, B);
        const refB = ref(B, A);
        if (a.length === 0 && b.length === 0 && refA === null && refB === null) continue;
        const somA = a.reduce((t, x) => t + x.saldo, 0);
        const somB = b.reduce((t, x) => t + x.saldo, 0);
        uit.push({ a, b, naamA: naam(A), naamB: naam(B), somA, somB, verschil: Math.round((somA + somB) * 100) / 100, refA, refB });
      }
    }
    return uit;
  }
}
