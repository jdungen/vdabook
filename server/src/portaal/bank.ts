import type pg from "pg";

/**
 * Bankboekingen: wat de boekhouder in de bank- en kasdagboeken van Globe
 * heeft ingevoerd, per afschrift (boekstuk), met wie en wanneer.
 *
 * Een bankdagboek wordt herkend aan het Globe-dagboek (tabel dagbk, type B of
 * K) en, als die informatie ontbreekt, aan de boekingen zelf: een dagboek
 * waarvan vrijwel elk boekstuk een bank- of kasrekening raakt. Het
 * achterstandsgetal is het verschil tussen de bankdatum van een regel en het
 * moment waarop hij in Globe is ingevoerd (syscreated).
 *
 * Alles leest uit de spiegel. Lonen worden hier bewust niet afgeschermd.
 */

/** Rekeningnamen van bank, kas en spaar; zelfde herkenning als de tegel liquide middelen. */
export const LIQUIDE = "(bank|\\mkas\\M|kasgeld|rabo|\\ming\\M|abn|knab|triodos|spaar|deposito|giro)";

/**
 * CTE's (zonder WITH) die de bank- en kasdagboeken van administratie $1 opleveren:
 * rek(grootboek, oms), liq(grootboek), dg, per, bank(dagboek, naam, soort, rekening, n, ...).
 * Gedeeld door de Bank-pagina en de auditcontroles.
 */
export const BANK_CTE = `rek AS (
         SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS oms
           FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk'),
       liq AS (
         SELECT grootboek FROM rek r
          WHERE oms ~* '${LIQUIDE}'
            AND EXISTS (SELECT 1 FROM globe_row g WHERE g.admin_key = $1 AND g.tbl = 'grtbk'
                          AND trim(g.data->>'reknr') = r.grootboek AND upper(trim(COALESCE(g.data->>'bal_vw', 'B'))) = 'B')),
       dg AS (
         SELECT trim(data->>'dagbknr') AS dagboek,
                COALESCE(data->>'oms25_0', data->>'oms25', data->>'omschrijving') AS naam,
                upper(trim(COALESCE(data->>'type_dgbk', data->>'dagbktype', data->>'type'))) AS soort,
                nullif(trim(COALESCE(data->>'reknr', data->>'grootboek')), '') AS rekening
           FROM globe_row WHERE admin_key = $1 AND tbl = 'dagbk'),
       per AS (
         SELECT m.dagboek,
                count(DISTINCT m.boekstuk) AS n,
                count(DISTINCT m.boekstuk) FILTER (WHERE liq.grootboek IS NOT NULL) AS n_liq,
                mode() WITHIN GROUP (ORDER BY liq.grootboek) FILTER (WHERE liq.grootboek IS NOT NULL) AS vaak_liq,
                min(m.datum) AS eerste_datum, max(m.datum) AS laatste_datum, max(m.geboekt_op) AS laatste_invoer
           FROM gb_mutatie m LEFT JOIN liq ON liq.grootboek = m.grootboek
          WHERE m.admin_key = $1 AND m.periode <> 0 AND m.dagboek IS NOT NULL
          GROUP BY m.dagboek),
       bank AS (
         SELECT per.*, dg.naam,
                CASE WHEN dg.soort = 'B' THEN 'bank' WHEN dg.soort = 'K' THEN 'kas' ELSE 'herkend' END AS soort,
                COALESCE(dg.rekening, per.vaak_liq) AS rekening
           FROM per LEFT JOIN dg ON dg.dagboek = per.dagboek
          WHERE dg.soort IN ('B', 'K')
             OR ((dg.soort IS NULL OR dg.soort NOT IN ('V', 'I', 'M', 'G', 'D', 'C')) AND per.n_liq >= 0.8 * per.n AND per.n_liq > 0))`;

export interface BankDagboek {
  dagboek: string;
  naam: string | null;
  soort: string; // bank | kas | herkend
  rekening: string | null;
  rekening_oms: string | null;
  boekstukken: number;
  eerste_datum: string | null;
  laatste_datum: string | null;
  laatste_invoer: string | null;
  saldo: string | null;
}

export class Bank {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Bank- en kasdagboeken met hun rekening en saldo eind boekjaar $2.
   * Dagboek-informatie uit Globe (dagbk) gaat voor; kolomnamen worden
   * defensief gelezen omdat ze per Globe-versie kunnen verschillen.
   */
  async dagboeken(admin: string, jaar: number): Promise<BankDagboek[]> {
    const r = await this.pool.query<BankDagboek>(
      `WITH ${BANK_CTE}
       SELECT b.dagboek, b.naam, b.soort, b.rekening, rek.oms AS rekening_oms,
              b.n::int AS boekstukken, b.eerste_datum, b.laatste_datum, b.laatste_invoer,
              (SELECT round(sum(s.bedrag), 2) FROM gb_mutatie s
                WHERE s.admin_key = $1 AND s.grootboek = b.rekening
                  AND (CASE WHEN EXISTS (SELECT 1 FROM gb_mutatie p WHERE p.admin_key = $1 AND p.boekjaar = $2 AND p.periode = 0)
                            THEN s.boekjaar = $2 ELSE s.boekjaar <= $2 END)) AS saldo
         FROM bank b LEFT JOIN rek ON rek.grootboek = b.rekening
        ORDER BY b.soort, b.dagboek`,
      [admin, jaar],
    );
    return r.rows;
  }

  /**
   * Afschriften (boekstukken) in één bankdagboek, nieuwste eerst.
   * mutatie = som van de regels op de bankrekening zelf (+ ontvangen, − betaald).
   */
  async afschriften(
    admin: string,
    dagboek: string,
    rekening: string | null,
    f: { jaar?: number; van?: string; tot?: string; gebruiker?: string; achter?: number },
    limiet: number,
    offset: number,
  ) {
    const r = await this.pool.query(
      `WITH st AS (
         SELECT m.dagboek, m.boekstuk,
                min(m.boekjaar) AS boekjaar, min(m.periode) AS periode,
                min(m.datum) AS datum_van, max(m.datum) AS datum_tot,
                sum(m.bedrag) FILTER (WHERE m.grootboek = $3) AS mutatie,
                sum(m.bedrag) FILTER (WHERE m.grootboek = $3 AND m.bedrag > 0) AS ontvangen,
                -sum(m.bedrag) FILTER (WHERE m.grootboek = $3 AND m.bedrag < 0) AS betaald,
                count(*) FILTER (WHERE m.grootboek IS DISTINCT FROM $3) AS regels,
                string_agg(DISTINCT m.gebruiker, ', ') AS gebruikers,
                min(m.geboekt_op) AS ingevoerd_van, max(m.geboekt_op) AS ingevoerd_tot,
                (min(m.geboekt_op)::date - max(m.datum)) AS dagen_later,
                count(*) FILTER (WHERE r.versies > 1) AS gewijzigd,
                min(m.omschrijving) FILTER (WHERE m.grootboek IS DISTINCT FROM $3) AS voorbeeld
           FROM gb_mutatie m
           LEFT JOIN globe_row r ON r.admin_key = m.admin_key AND r.tbl = 'gbkmut' AND r.pk = m.pk
          WHERE m.admin_key = $1 AND m.dagboek = $2 AND m.periode <> 0
            AND ($4::int IS NULL OR m.boekjaar = $4)
          GROUP BY m.dagboek, m.boekstuk)
       SELECT st.*,
              (SELECT count(*) FROM globe_row_historie h
                WHERE h.admin_key = $1 AND h.tbl = 'gbkmut' AND h.soort = 'verwijderd'
                  AND trim(COALESCE(h.data_oud->>'dagbknr', '')) = st.dagboek
                  AND trim(COALESCE(h.data_oud->>'bkstnr', '')) = st.boekstuk) AS verwijderd,
              count(*) OVER () AS totaal_aantal,
              sum(st.mutatie) OVER () AS totaal_mutatie
         FROM st
        WHERE ($5::date IS NULL OR st.datum_tot >= $5)
          AND ($6::date IS NULL OR st.datum_van <= $6)
          AND ($7::text IS NULL OR st.gebruikers ILIKE '%' || $7 || '%')
          AND ($8::int IS NULL OR st.dagen_later >= $8)
        ORDER BY st.datum_tot DESC NULLS LAST, st.boekstuk DESC
        LIMIT $9 OFFSET $10`,
      [admin, dagboek, rekening, f.jaar ?? null, f.van ?? null, f.tot ?? null, f.gebruiker ?? null, f.achter ?? null, limiet, offset],
    );
    return {
      rijen: r.rows,
      aantal: Number(r.rows[0]?.totaal_aantal ?? 0),
      mutatie: Number(r.rows[0]?.totaal_mutatie ?? 0),
    };
  }

  /**
   * Werkritme: per invoerdag en gebruiker hoeveel bankregels er zijn
   * ingevoerd, en over welke bankdata die gingen. Een middag waarin een hele
   * maand wordt bijgewerkt is hier direct te zien.
   */
  async invoerdagen(admin: string, dagboeken: string[], dagen: number) {
    const r = await this.pool.query(
      `SELECT m.geboekt_op::date AS dag, m.gebruiker, m.dagboek,
              count(DISTINCT m.boekstuk) AS boekstukken, count(*) AS regels,
              min(m.datum) AS bank_van, max(m.datum) AS bank_tot,
              round(avg(m.geboekt_op::date - m.datum)) AS gem_dagen_later,
              max(m.geboekt_op::date - m.datum) AS max_dagen_later
         FROM gb_mutatie m
        WHERE m.admin_key = $1 AND m.dagboek = ANY($2::text[]) AND m.periode <> 0
          AND m.geboekt_op >= (now() - make_interval(days => $3))::date
        GROUP BY 1, 2, 3
        ORDER BY 1 DESC, 3, 2`,
      [admin, dagboeken, dagen],
    );
    return r.rows;
  }

  /** Achterstand per maand: hoe lang na de bankdatum werd er gemiddeld ingevoerd. */
  async perMaand(admin: string, dagboek: string, jaar: number) {
    const r = await this.pool.query(
      `SELECT extract(month FROM m.datum)::int AS maand,
              count(DISTINCT m.boekstuk) AS boekstukken, count(*) AS regels,
              round(avg(m.geboekt_op::date - m.datum)) AS gem_dagen_later,
              max(m.geboekt_op::date - m.datum) AS max_dagen_later,
              max(m.geboekt_op) AS laatste_invoer
         FROM gb_mutatie m
        WHERE m.admin_key = $1 AND m.dagboek = $2 AND m.periode <> 0 AND extract(year FROM m.datum) = $3
        GROUP BY 1 ORDER BY 1`,
      [admin, dagboek, jaar],
    );
    return r.rows as Array<{ maand: number; boekstukken: string; regels: string; gem_dagen_later: string | null; max_dagen_later: number | null; laatste_invoer: string | null }>;
  }
}

/** Veld uit een banktransactions-rij (alias t). Globe-kolommen staan in kleine letters in de spiegel. */
const bt = (k: string) => `nullif(trim(t.data->>'${k}'), '')`;
/** Datum van een bankregel: valutadatum, anders afschriftdatum, anders verwerkingsdatum. */
const BT_DATUM = `COALESCE(vda_datum(t.data->>'valuedate'), vda_datum(t.data->>'statementdate'), vda_datum(t.data->>'processingdate'))`;
/** Ingelezen = er hangt een importbestand aan de regel. */
const BT_BESTAND = `(${bt("filename")} IS NOT NULL)`;
/** Geboekt = er is een boekstuknummer of een koppeling met een boeking. */
const BT_GEBOEKT = `(${bt("entrynumber")} IS NOT NULL OR ${bt("matchid")} IS NOT NULL)`;

export interface BankregelFilter {
  type?: string;
  status?: string;
  bron?: "bestand" | "zonder";
  geboekt?: "ja" | "nee";
  van?: string;
  tot?: string;
  zoek?: string;
}

export class Bankregels {
  constructor(private readonly pool: pg.Pool) {}

  /** Samenstelling van de tabel: per type, status, afschrifttype en wel/geen importbestand. */
  async samenstelling(admin: string) {
    const r = await this.pool.query(
      `SELECT ${bt("type")} AS type, ${bt("status")} AS status, ${bt("statementtype")} AS afschrifttype, ${BT_BESTAND} AS bestand,
              count(*) AS regels, min(${BT_DATUM}) AS eerste, max(${BT_DATUM}) AS laatste,
              max(vda_tijd(t.data->>'syscreated')) AS laatst_aangemaakt, max(vda_tijd(t.data->>'sysmodified')) AS laatst_gewijzigd
         FROM globe_row t WHERE t.admin_key = $1 AND t.tbl = 'banktransactions'
        GROUP BY 1, 2, 3, 4 ORDER BY count(*) DESC LIMIT 60`,
      [admin],
    );
    return r.rows;
  }

  /** Per maand (bankdatum), alle regels behalve termijnen (type W): ingelezen, geboekt, wie en hoe snel. */
  async perMaand(admin: string, maanden: number) {
    const r = await this.pool.query(
      `SELECT date_trunc('month', ${BT_DATUM})::date AS maand,
              count(*) AS regels,
              count(*) FILTER (WHERE ${BT_BESTAND}) AS met_bestand,
              count(*) FILTER (WHERE ${BT_GEBOEKT}) AS geboekt,
              count(*) FILTER (WHERE NOT ${BT_GEBOEKT}) AS niet_geboekt,
              count(DISTINCT ${bt("filename")}) AS bestanden,
              string_agg(DISTINCT ${bt("syscreator")}, ', ') AS aangemaakt_door,
              round(avg(vda_tijd(t.data->>'syscreated')::date - ${BT_DATUM})) AS gem_dagen_later
         FROM globe_row t
        WHERE t.admin_key = $1 AND t.tbl = 'banktransactions' AND COALESCE(${bt("type")}, '') <> 'W'
          AND ${BT_DATUM} >= (date_trunc('month', now()) - make_interval(months => $2))::date
        GROUP BY 1 ORDER BY 1 DESC`,
      [admin, maanden],
    );
    return r.rows;
  }

  /** Losse bankregels met filters, nieuwste eerst. */
  async regels(admin: string, f: BankregelFilter, limiet: number, offset: number) {
    const r = await this.pool.query(
      `SELECT t.pk, ${BT_DATUM} AS datum, ${bt("type")} AS type, ${bt("status")} AS status, ${bt("statementtype")} AS afschrifttype,
              ${bt("statementnumber")} AS afschrift, ${bt("statementlinenumber")} AS afschriftregel, ${bt("ownbankaccount")} AS eigen_rekening,
              ${bt("offsetname")} AS tegenpartij, ${bt("offsetbankaccount")} AS tegenrekening, ${bt("description")} AS omschrijving,
              vda_num(t.data->>'amountdc') AS bedrag, ${bt("filename")} AS bestand, ${bt("entrynumber")} AS boekstuk, ${bt("matchid")} AS matchid,
              ${bt("ledgeraccount")} AS grootboek, ${bt("offsetledgeraccountnumber")} AS tegengrootboek,
              ${bt("debtornumber")} AS debiteur, ${bt("creditornumber")} AS crediteur, ${bt("invoicenumber")} AS factuur,
              vda_tijd(t.data->>'syscreated') AS aangemaakt, ${bt("syscreator")} AS aangemaakt_door,
              vda_tijd(t.data->>'sysmodified') AS gewijzigd, ${bt("sysmodifier")} AS gewijzigd_door, t.versies,
              count(*) OVER () AS totaal_aantal, sum(vda_num(t.data->>'amountdc')) OVER () AS totaal_bedrag
         FROM globe_row t
        WHERE t.admin_key = $1 AND t.tbl = 'banktransactions'
          AND (CASE WHEN $2::text IS NULL THEN COALESCE(${bt("type")}, '') <> 'W' ELSE ${bt("type")} = $2 END)
          AND ($3::text IS NULL OR ${bt("status")} = $3)
          AND ($4::text IS NULL OR ($4 = 'bestand') = ${BT_BESTAND})
          AND ($5::text IS NULL OR ($5 = 'ja') = ${BT_GEBOEKT})
          AND ($6::date IS NULL OR ${BT_DATUM} >= $6)
          AND ($7::date IS NULL OR ${BT_DATUM} <= $7)
          AND ($8::text IS NULL OR t.data->>'offsetname' ILIKE '%' || $8 || '%' OR t.data->>'description' ILIKE '%' || $8 || '%'
               OR t.data->>'offsetbankaccount' ILIKE '%' || $8 || '%' OR trim(t.data->>'entrynumber') = $8 OR trim(t.data->>'statementnumber') = $8)
        ORDER BY ${BT_DATUM} DESC NULLS LAST, t.pk DESC
        LIMIT $9 OFFSET $10`,
      [admin, f.type ?? null, f.status ?? null, f.bron ?? null, f.geboekt ?? null, f.van ?? null, f.tot ?? null, f.zoek ?? null, limiet, offset],
    );
    return { rijen: r.rows, aantal: Number(r.rows[0]?.totaal_aantal ?? 0), som: Number(r.rows[0]?.totaal_bedrag ?? 0) };
  }
}
