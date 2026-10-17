import type pg from "pg";
import { LOON_REKENING } from "./rapport.js";

/**
 * Auditcontroles op de Globe-spiegel.
 *
 * Elke controle geeft bevindingen met een stabiele sleutel, zodat een
 * beoordeling (akkoord / vraag / afwijking + opmerking) aan die bevinding
 * blijft hangen, ook na de volgende sync. De controles zijn signalen voor een
 * mens, geen oordeel: een ronde factuur of een boeking op zaterdag kan prima
 * kloppen. Daarom staat bij elke controle wat hij wel en niet zegt.
 *
 * Parameters in elke query: $1 = admin_key, $2 = boekjaar.
 */

export type Soort = "tekst" | "bedrag" | "datum" | "tijd" | "getal" | "boekstuk" | "grootboek" | "diff";

export interface Kolom {
  k: string;
  label: string;
  soort?: Soort;
}

export interface Controle {
  id: string;
  titel: string;
  /** Wat de controle zoekt en waarom het ertoe doet. */
  uitleg: string;
  /** Wat een bevinding níet betekent. */
  kanttekening?: string;
  kolommen: Kolom[];
  sql: (lonen: boolean) => string;
}

const REK = `rek AS (SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS go, upper(trim(data->>'bal_vw')) AS bal_vw
                       FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk')`;
const BEGIN = `begin AS (SELECT EXISTS (SELECT 1 FROM gb_mutatie WHERE admin_key = $1 AND boekjaar = $2 AND periode = 0) AS ja)`;
const SALDO_TOT_JAAR = `CASE WHEN (SELECT ja FROM begin) THEN m.boekjaar = $2 ELSE m.boekjaar <= $2 END`;
const RUIS = `('timestamp', 'sysmodified', 'sysmodifier', 'sysguid', 'syscreated', 'syscreator')`;
/** Boekstuk (alias m) zonder regels op loonrekeningen; voor controles die per boekstuk tonen. */
const geenLoonBoekstuk = (lonen: boolean, m = "gb_mutatie") =>
  lonen
    ? "TRUE"
    : `NOT EXISTS (SELECT 1 FROM gb_mutatie lx JOIN globe_row lr ON lr.admin_key = lx.admin_key AND lr.tbl = 'grtbk' AND trim(lr.data->>'reknr') = lx.grootboek
                    WHERE lx.admin_key = ${m}.admin_key AND lx.dagboek = ${m}.dagboek AND lx.boekstuk = ${m}.boekstuk
                      AND COALESCE(lr.data->>'oms25_0', '') ~* '${LOON_REKENING}')`;
const zonderLonen = (lonen: boolean, kolom: string) => (lonen ? "TRUE" : `NOT (COALESCE(${kolom}, '') ~* '${LOON_REKENING}')`);

export const CONTROLES: Controle[] = [
  {
    id: "tussenrekeningen",
    titel: "Tussen- en vraagpostrekeningen met saldo",
    uitleg:
      "Rekeningen voor vraagposten, kruisposten, onbekende betalingen, te verdelen en afrondingsverschillen horen per balansdatum leeg te zijn. Een saldo betekent dat er boekingen geparkeerd staan die nog een echte tegenrekening moeten krijgen.",
    kanttekening: "Herkend aan de naam van de rekening. Kruisposten die elkaar binnen een paar dagen opheffen zijn geen werk.",
    kolommen: [
      { k: "grootboek", label: "Rekening", soort: "grootboek" },
      { k: "omschrijving", label: "Omschrijving" },
      { k: "saldo", label: "Saldo eind jaar", soort: "bedrag" },
      { k: "regels", label: "Regels", soort: "getal" },
      { k: "laatste", label: "Laatste mutatie", soort: "datum" },
    ],
    sql: () => `WITH ${REK}, ${BEGIN}
      SELECT rek.grootboek, rek.grootboek || '|' || $2 AS sleutel, rek.go AS omschrijving,
             round(sum(m.bedrag), 2) AS saldo, count(*) AS regels, max(m.datum) AS laatste
        FROM rek JOIN gb_mutatie m ON m.admin_key = $1 AND m.grootboek = rek.grootboek
       WHERE rek.go ~* '(vraagpost|kruispost|tussenrek|onbekend|te verdelen|nog te verwerken|wachtrek|afrond|verschillen|onduidelijk|nader te)'
         AND ${SALDO_TOT_JAAR}
       GROUP BY rek.grootboek, rek.go
      HAVING abs(sum(m.bedrag)) > 0.005
       ORDER BY abs(sum(m.bedrag)) DESC`,
  },
  {
    id: "btw",
    titel: "Btw-signalen per boekstuk",
    uitleg:
      "Per boekstuk wordt de btw (regels op btw-rekeningen) vergeleken met de grondslag (regels met een btw-code). Gesignaleerd: btw op de verkeerde kant — inkoop-btw op een af-te-dragen-rekening of omzet-btw op voorbelasting, de fout die bij Resolvit de rubrieken 1a en 5b vertekende — plus btw met het tegengestelde teken van de grondslag en een effectief tarief dat niet bij 21%, 9% of 0% past.",
    kanttekening: "Btw-rekeningen worden herkend aan de naam. Boekstukken met gemengde tarieven kunnen een tussenliggend tarief geven zonder fout te zijn.",
    kolommen: [
      { k: "boekstuk", label: "Boekstuk", soort: "boekstuk" },
      { k: "datum", label: "Datum", soort: "datum" },
      { k: "omschrijving", label: "Omschrijving" },
      { k: "grondslag", label: "Grondslag", soort: "bedrag" },
      { k: "btw", label: "Btw", soort: "bedrag" },
      { k: "tarief", label: "Tarief" },
      { k: "signaal", label: "Signaal" },
    ],
    sql: (lonen) => `WITH ${REK},
      btwrek AS (SELECT grootboek,
                        CASE WHEN go ~* '(te vorderen|voorbelasting)' THEN 'inkoop'
                             WHEN go ~* '(af te dragen|verschuldigd|te betalen|omzetbelasting|verlegd)' THEN 'verkoop'
                             ELSE 'onbekend' END AS kant
                   FROM rek WHERE go ~* '(btw|omzetbelasting|voorbelasting|af te dragen|te vorderen|verlegd)'),
      per AS (
        SELECT m.dagboek, m.boekstuk, min(m.datum) AS datum, min(m.omschrijving) AS omschrijving,
               sum(m.bedrag) FILTER (WHERE b.grootboek IS NOT NULL) AS btw,
               sum(m.bedrag) FILTER (WHERE b.kant = 'inkoop') AS btw_inkoop,
               sum(m.bedrag) FILTER (WHERE b.kant = 'verkoop') AS btw_verkoop,
               sum(m.bedrag) FILTER (WHERE m.btw_code IS NOT NULL AND b.grootboek IS NULL) AS grondslag
          FROM gb_mutatie m LEFT JOIN btwrek b ON b.grootboek = m.grootboek
         WHERE m.admin_key = $1 AND m.boekjaar = $2 AND m.periode <> 0 AND ${geenLoonBoekstuk(lonen, "m")}
         GROUP BY m.dagboek, m.boekstuk),
      sig AS (
        SELECT *, CASE
            WHEN grondslag > 0 AND abs(COALESCE(btw_verkoop, 0)) > 0.01 THEN 'kosten/inkoop met btw op een af-te-dragen-rekening (rubriek 1 i.p.v. 5b?)'
            WHEN grondslag < 0 AND abs(COALESCE(btw_inkoop, 0)) > 0.01 THEN 'omzet met btw op een voorbelastingrekening (rubriek 5b i.p.v. 1?)'
            WHEN sign(btw) <> sign(grondslag) THEN 'btw tegengesteld aan grondslag'
            WHEN abs(abs(btw / grondslag) - 0.21) > 0.005 AND abs(abs(btw / grondslag) - 0.09) > 0.005 THEN 'tarief past niet bij 21%, 9% of 0%'
          END AS signaal
          FROM per WHERE btw IS NOT NULL AND grondslag IS NOT NULL AND grondslag <> 0 AND abs(btw) > 0.01)
      SELECT dagboek, boekstuk, dagboek || '|' || boekstuk AS sleutel, datum, omschrijving,
             round(grondslag, 2) AS grondslag, round(btw, 2) AS btw,
             replace(to_char(abs(btw / grondslag) * 100, 'FM990.0'), '.', ',') || '%' AS tarief, signaal
        FROM sig WHERE signaal IS NOT NULL
       ORDER BY abs(btw) DESC`,
  },
  {
    id: "balans_boekstuk",
    titel: "Boekstukken die niet in balans zijn",
    uitleg: "Debet en credit van één boekstuk horen samen nul te zijn. Een verschil wijst op een onvolledige of handmatig gecorrigeerde boeking.",
    kanttekening: "Budgetregels en andere bijzondere transactiesoorten tellen mee; de kolom transactiesoort laat zien of daar sprake van is.",
    kolommen: [
      { k: "boekstuk", label: "Boekstuk", soort: "boekstuk" },
      { k: "datum", label: "Datum", soort: "datum" },
      { k: "verschil", label: "Verschil", soort: "bedrag" },
      { k: "regels", label: "Regels", soort: "getal" },
      { k: "transtypes", label: "Transactiesoort" },
    ],
    sql: (lonen) => `SELECT dagboek, boekstuk, dagboek || '|' || boekstuk AS sleutel, min(datum) AS datum,
             round(sum(bedrag), 2) AS verschil, count(*) AS regels, string_agg(DISTINCT transtype, ', ') AS transtypes
        FROM gb_mutatie WHERE admin_key = $1 AND boekjaar = $2 AND ${geenLoonBoekstuk(lonen)}
       GROUP BY dagboek, boekstuk HAVING abs(sum(bedrag)) > 0.005
       ORDER BY abs(sum(bedrag)) DESC`,
  },
  {
    id: "nummering",
    titel: "Gaten in de boekstuknummering",
    uitleg: "Per dagboek horen boekstuknummers doorlopend te zijn. Een gat kan een verwijderde boeking zijn. Combineer met 'Verwijderd na boeking' om te zien of de spiegel die verwijdering heeft gezien.",
    kanttekening: "Alleen numerieke boekstuknummers. Een gat vóór de eerste sync is niet terug te halen uit de spiegel.",
    kolommen: [
      { k: "dagboek", label: "Dagboek" },
      { k: "van", label: "Van", soort: "tekst" },
      { k: "tot", label: "Tot en met", soort: "tekst" },
      { k: "aantal", label: "Ontbrekend", soort: "getal" },
    ],
    sql: (lonen) => `WITH n AS (SELECT DISTINCT dagboek, boekstuk::bigint AS nr FROM gb_mutatie
                         WHERE admin_key = $1 AND boekjaar = $2 AND boekstuk ~ '^\\d{1,15}$'),
           g AS (SELECT dagboek, nr, lead(nr) OVER (PARTITION BY dagboek ORDER BY nr) AS volgende FROM n)
      SELECT dagboek, (nr + 1)::text AS van, (volgende - 1)::text AS tot, volgende - nr - 1 AS aantal,
             dagboek || '|' || (nr + 1) || '-' || (volgende - 1) AS sleutel
        FROM g WHERE volgende - nr > 1 ORDER BY dagboek, nr`,
  },
  {
    id: "gewijzigd",
    titel: "Achteraf gewijzigde boekingen",
    uitleg:
      "Boekingsregels die in Globe zijn aangepast nadat de spiegel ze al had gezien: wat er veranderde, oud en nieuw. Dit is precies wat een zwarte doos onzichtbaar maakt — een bedrag, rekening of omschrijving die na de feiten is bijgesteld.",
    kanttekening: "Technische velden (tijdstempels, wijzigingsmarkeringen) tellen niet mee. Wijzigingen vóór de eerste sync zijn niet zichtbaar.",
    kolommen: [
      { k: "gemerkt_op", label: "Gezien op", soort: "tijd" },
      { k: "boekstuk", label: "Boekstuk", soort: "boekstuk" },
      { k: "grootboek", label: "Rekening", soort: "grootboek" },
      { k: "velden", label: "Gewijzigd" },
      { k: "diff", label: "Oud → nieuw", soort: "diff" },
    ],
    sql: (lonen) => `SELECT 'h' || h.id AS sleutel, h.gemerkt_op,
             trim(h.data_oud->>'dagbknr') AS dagboek, trim(h.data_oud->>'bkstnr') AS boekstuk, trim(h.data_oud->>'reknr') AS grootboek,
             d.velden, d.diff
        FROM globe_row_historie h
        CROSS JOIN LATERAL (
          SELECT string_agg(o.key, ', ' ORDER BY o.key) AS velden,
                 jsonb_object_agg(o.key, jsonb_build_array(o.value, h.data_nieuw->o.key)) AS diff
            FROM jsonb_each(h.data_oud) o
           WHERE o.value IS DISTINCT FROM h.data_nieuw->o.key AND o.key NOT IN ${RUIS}) d
        LEFT JOIN (SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS go FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk') rek
               ON rek.grootboek = trim(h.data_oud->>'reknr')
       WHERE h.admin_key = $1 AND h.tbl = 'gbkmut' AND h.soort = 'gewijzigd'
         AND ${lonen ? "TRUE" : `COALESCE(h.data_oud->>'oms25', '') !~* '${LOON_REKENING}' AND NOT EXISTS (
               SELECT 1 FROM gb_mutatie lx JOIN globe_row lr ON lr.admin_key = lx.admin_key AND lr.tbl = 'grtbk' AND trim(lr.data->>'reknr') = lx.grootboek
                WHERE lx.admin_key = h.admin_key AND lx.dagboek = trim(h.data_oud->>'dagbknr') AND lx.boekstuk = trim(h.data_oud->>'bkstnr')
                  AND COALESCE(lr.data->>'oms25_0', '') ~* '${LOON_REKENING}')`}
         AND vda_int(h.data_oud->>'bkjrcode') = $2 AND d.velden IS NOT NULL
         AND ${zonderLonen(lonen, "rek.go")}
       ORDER BY h.gemerkt_op DESC`,
  },
  {
    id: "verwijderd",
    titel: "Verwijderd na boeking",
    uitleg: "Boekingsregels die de spiegel heeft gezien en die daarna uit Globe zijn verdwenen. De laatste versie staat hier nog.",
    kanttekening: "Verwijderingen worden eens per dag vastgesteld (sleutelscan). Grote aantallen tegelijk worden niet verwerkt maar in de syncstatus gemeld.",
    kolommen: [
      { k: "gemerkt_op", label: "Gezien op", soort: "tijd" },
      { k: "boekstuk", label: "Boekstuk", soort: "boekstuk" },
      { k: "datum", label: "Boekdatum", soort: "datum" },
      { k: "grootboek", label: "Rekening", soort: "grootboek" },
      { k: "omschrijving", label: "Omschrijving" },
      { k: "bedrag", label: "Bedrag", soort: "bedrag" },
    ],
    sql: (lonen) => `SELECT 'h' || h.id AS sleutel, h.gemerkt_op,
             trim(h.data_oud->>'dagbknr') AS dagboek, trim(h.data_oud->>'bkstnr') AS boekstuk,
             vda_datum(h.data_oud->>'datum') AS datum, trim(h.data_oud->>'reknr') AS grootboek,
             h.data_oud->>'oms25' AS omschrijving, vda_num(h.data_oud->>'bdr_hfl') AS bedrag
        FROM globe_row_historie h
        LEFT JOIN (SELECT trim(data->>'reknr') AS grootboek, data->>'oms25_0' AS go FROM globe_row WHERE admin_key = $1 AND tbl = 'grtbk') rek
               ON rek.grootboek = trim(h.data_oud->>'reknr')
       WHERE h.admin_key = $1 AND h.tbl = 'gbkmut' AND h.soort = 'verwijderd' AND vda_int(h.data_oud->>'bkjrcode') = $2
         AND ${lonen ? "TRUE" : `COALESCE(h.data_oud->>'oms25', '') !~* '${LOON_REKENING}' AND NOT EXISTS (
               SELECT 1 FROM gb_mutatie lx JOIN globe_row lr ON lr.admin_key = lx.admin_key AND lr.tbl = 'grtbk' AND trim(lr.data->>'reknr') = lx.grootboek
                WHERE lx.admin_key = h.admin_key AND lx.dagboek = trim(h.data_oud->>'dagbknr') AND lx.boekstuk = trim(h.data_oud->>'bkstnr')
                  AND COALESCE(lr.data->>'oms25_0', '') ~* '${LOON_REKENING}')`}
         AND ${zonderLonen(lonen, "rek.go")}
       ORDER BY h.gemerkt_op DESC`,
  },
  {
    id: "buiten_kantoortijd",
    titel: "Geboekt in het weekend of buiten kantoortijd",
    uitleg:
      "Boekstukken die in het weekend of tussen 20:00 en 07:00 zijn ingevoerd. Ongebruikelijke invoermomenten zijn een klassiek signaal bij fraudeonderzoek. Waar Globe het invoertijdstip niet vastlegt, wordt de boekdatum gebruikt (alleen weekend).",
    kolommen: [
      { k: "boekstuk", label: "Boekstuk", soort: "boekstuk" },
      { k: "moment", label: "Moment", soort: "tijd" },
      { k: "grondslag", label: "Op basis van" },
      { k: "gebruiker", label: "Gebruiker" },
      { k: "omvang", label: "Omvang", soort: "bedrag" },
    ],
    sql: (lonen) => `SELECT dagboek, boekstuk, dagboek || '|' || boekstuk AS sleutel,
             COALESCE(min(geboekt_op), min(datum)::timestamp) AS moment,
             CASE WHEN min(geboekt_op) IS NOT NULL THEN 'invoertijdstip' ELSE 'boekdatum' END AS grondslag,
             min(gebruiker) AS gebruiker, round(sum(abs(bedrag)) / 2, 2) AS omvang
        FROM gb_mutatie WHERE admin_key = $1 AND boekjaar = $2 AND ${geenLoonBoekstuk(lonen)} AND periode <> 0
       GROUP BY dagboek, boekstuk
      HAVING CASE WHEN min(geboekt_op) IS NOT NULL
                  THEN extract(isodow FROM min(geboekt_op)) >= 6 OR extract(hour FROM min(geboekt_op)) >= 20 OR extract(hour FROM min(geboekt_op)) < 7
                  ELSE extract(isodow FROM min(datum)) >= 6 END
       ORDER BY sum(abs(bedrag)) DESC`,
  },
  {
    id: "ronde_bedragen",
    titel: "Ronde bedragen",
    uitleg: "Regels van € 1.000 of meer op een veelvoud van € 500. Echte facturen zijn zelden rond; ronde bedragen komen vaker voor bij schattingen, correcties en onderlinge verrekeningen.",
    kanttekening: "Huur, leningen en vaste vergoedingen zijn vaak terecht rond.",
    kolommen: [
      { k: "boekstuk", label: "Boekstuk", soort: "boekstuk" },
      { k: "datum", label: "Datum", soort: "datum" },
      { k: "grootboek", label: "Rekening", soort: "grootboek" },
      { k: "omschrijving", label: "Omschrijving" },
      { k: "bedrag", label: "Bedrag", soort: "bedrag" },
    ],
    sql: (lonen) => `WITH ${REK}
      SELECT m.dagboek, m.boekstuk, m.dagboek || '|' || m.boekstuk || '|' || m.pk AS sleutel, m.datum, m.grootboek, m.omschrijving, m.bedrag
        FROM gb_mutatie m LEFT JOIN rek ON rek.grootboek = m.grootboek
       WHERE m.admin_key = $1 AND m.boekjaar = $2 AND m.periode <> 0
         AND abs(m.bedrag) >= 1000 AND mod(abs(m.bedrag), 500) = 0
         AND COALESCE(rek.go, '') !~* '(bank|\\mkas\\M|rabo|abn|knab|giro)'
         AND ${zonderLonen(lonen, "rek.go")} AND ${geenLoonBoekstuk(lonen, "m")}
       ORDER BY abs(m.bedrag) DESC`,
  },
  {
    id: "grote_bedragen",
    titel: "De 50 grootste boekstukken",
    uitleg: "Waar het geld zit. Een accountant kijkt altijd naar de posten die het resultaat of de balans het meest bepalen.",
    kolommen: [
      { k: "boekstuk", label: "Boekstuk", soort: "boekstuk" },
      { k: "datum", label: "Datum", soort: "datum" },
      { k: "omschrijving", label: "Omschrijving" },
      { k: "omvang", label: "Omvang", soort: "bedrag" },
      { k: "rekeningen", label: "Rekeningen" },
    ],
    sql: (lonen) => `SELECT dagboek, boekstuk, dagboek || '|' || boekstuk AS sleutel, min(datum) AS datum, min(omschrijving) AS omschrijving,
             round(sum(abs(bedrag)) / 2, 2) AS omvang, string_agg(DISTINCT grootboek, ', ') AS rekeningen
        FROM gb_mutatie WHERE admin_key = $1 AND boekjaar = $2 AND ${geenLoonBoekstuk(lonen)} AND periode <> 0
       GROUP BY dagboek, boekstuk ORDER BY sum(abs(bedrag)) DESC LIMIT 50`,
  },
  {
    id: "dubbel",
    titel: "Mogelijk dubbel geboekte facturen",
    uitleg: "Dezelfde relatie en hetzelfde factuurnummer in meer dan één boekstuk binnen hetzelfde dagboek. Betalingen in een bankdagboek tellen niet mee; die horen het factuurnummer te delen.",
    kolommen: [
      { k: "dagboek", label: "Dagboek" },
      { k: "relatie", label: "Relatie" },
      { k: "factuurnr", label: "Factuurnr" },
      { k: "boekstukken", label: "Boekstukken" },
      { k: "bedragen", label: "Bedragen" },
    ],
    sql: (lonen) => `SELECT dagboek, COALESCE(crediteur, debiteur) AS relatie, factuurnr,
             dagboek || '|' || COALESCE(crediteur, debiteur) || '|' || factuurnr AS sleutel,
             string_agg(DISTINCT boekstuk, ', ') AS boekstukken,
             string_agg(DISTINCT replace(to_char(bedrag, 'FM9999999990.00'), '.', ','), ' / ') AS bedragen
        FROM gb_mutatie
       WHERE admin_key = $1 AND boekjaar = $2 AND ${geenLoonBoekstuk(lonen)} AND factuurnr IS NOT NULL AND COALESCE(crediteur, debiteur) IS NOT NULL
       GROUP BY dagboek, COALESCE(crediteur, debiteur), factuurnr
      HAVING count(DISTINCT boekstuk) > 1
       ORDER BY dagboek, relatie`,
  },
  {
    id: "datum_buiten_jaar",
    titel: "Boekdatum buiten het boekjaar",
    uitleg: "Regels waarvan de boekdatum in een ander kalenderjaar valt dan het boekjaar. Kan terecht zijn (een late factuur), maar ook resultaat naar het verkeerde jaar verschuiven.",
    kanttekening: "Heeft een administratie een gebroken boekjaar, dan is deze controle niet bruikbaar.",
    kolommen: [
      { k: "boekstuk", label: "Boekstuk", soort: "boekstuk" },
      { k: "datum", label: "Boekdatum", soort: "datum" },
      { k: "periode", label: "Periode", soort: "getal" },
      { k: "omvang", label: "Omvang", soort: "bedrag" },
      { k: "omschrijving", label: "Omschrijving" },
    ],
    sql: (lonen) => `SELECT dagboek, boekstuk, dagboek || '|' || boekstuk AS sleutel, min(datum) AS datum, min(periode) AS periode,
             round(sum(abs(bedrag)) / 2, 2) AS omvang, min(omschrijving) AS omschrijving
        FROM gb_mutatie WHERE admin_key = $1 AND boekjaar = $2 AND ${geenLoonBoekstuk(lonen)} AND periode <> 0 AND extract(year FROM datum) <> boekjaar
       GROUP BY dagboek, boekstuk ORDER BY min(datum)`,
  },
  {
    id: "datum_toekomst",
    titel: "Boekdatum in de toekomst",
    uitleg: "Boekstukken met een boekdatum na vandaag. Bijna altijd een tikfout in het jaartal (2026 in plaats van 2025); vooruitgeboekte memoriaalposten kunnen terecht zijn.",
    kolommen: [
      { k: "boekstuk", label: "Boekstuk", soort: "boekstuk" },
      { k: "datum", label: "Boekdatum", soort: "datum" },
      { k: "periode", label: "Periode", soort: "getal" },
      { k: "omvang", label: "Omvang", soort: "bedrag" },
      { k: "omschrijving", label: "Omschrijving" },
    ],
    sql: (lonen) => `SELECT dagboek, boekstuk, dagboek || '|' || boekstuk AS sleutel, min(datum) AS datum, min(periode) AS periode,
             round(sum(abs(bedrag)) / 2, 2) AS omvang, min(omschrijving) AS omschrijving
        FROM gb_mutatie WHERE admin_key = $1 AND boekjaar = $2 AND ${geenLoonBoekstuk(lonen)} AND datum > current_date
       GROUP BY dagboek, boekstuk ORDER BY min(datum)`,
  },
  {
    id: "onbekende_rekening",
    titel: "Boekingen op onbekende rekeningen",
    uitleg: "Mutaties op een grootboekrekening die niet (meer) in het rekeningschema staat.",
    kolommen: [
      { k: "grootboek", label: "Rekening", soort: "grootboek" },
      { k: "regels", label: "Regels", soort: "getal" },
      { k: "saldo", label: "Saldo", soort: "bedrag" },
    ],
    sql: () => `WITH ${REK}
      SELECT m.grootboek, m.grootboek AS sleutel, count(*) AS regels, round(sum(m.bedrag), 2) AS saldo
        FROM gb_mutatie m WHERE m.admin_key = $1 AND m.boekjaar = $2
         AND NOT EXISTS (SELECT 1 FROM rek WHERE rek.grootboek = m.grootboek)
       GROUP BY m.grootboek ORDER BY m.grootboek`,
  },
  {
    id: "negatieve_kas",
    titel: "Negatief kassaldo",
    uitleg: "Dagen waarop een kasrekening onder nul stond. Een kas kan niet negatief zijn; het wijst op ontbrekende of te laat geboekte ontvangsten.",
    kolommen: [
      { k: "grootboek", label: "Rekening", soort: "grootboek" },
      { k: "omschrijving", label: "Omschrijving" },
      { k: "datum", label: "Datum", soort: "datum" },
      { k: "saldo", label: "Saldo", soort: "bedrag" },
    ],
    sql: () => `WITH ${REK}, ${BEGIN},
      kas AS (SELECT grootboek, go FROM rek WHERE go ~* '\\mkas\\M' AND bal_vw = 'B'),
      start AS (SELECT k.grootboek, COALESCE(sum(m.bedrag), 0) AS s FROM kas k
                  LEFT JOIN gb_mutatie m ON m.admin_key = $1 AND m.grootboek = k.grootboek
                   AND CASE WHEN (SELECT ja FROM begin) THEN m.boekjaar = $2 AND m.periode = 0 ELSE m.boekjaar < $2 END
                 GROUP BY k.grootboek),
      dag AS (SELECT m.grootboek, m.datum, sum(m.bedrag) AS mut FROM gb_mutatie m JOIN kas k USING (grootboek)
               WHERE m.admin_key = $1 AND m.boekjaar = $2 AND m.periode <> 0 GROUP BY m.grootboek, m.datum),
      loop AS (SELECT d.grootboek, d.datum, s.s + sum(d.mut) OVER (PARTITION BY d.grootboek ORDER BY d.datum) AS saldo
                 FROM dag d JOIN start s USING (grootboek))
      SELECT l.grootboek, k.go AS omschrijving, l.datum, round(l.saldo, 2) AS saldo, l.grootboek || '|' || l.datum AS sleutel
        FROM loop l JOIN kas k USING (grootboek) WHERE l.saldo < -0.005 ORDER BY l.grootboek, l.datum`,
  },
];

export interface Beoordeling {
  sleutel: string;
  status: "akkoord" | "vraag" | "afwijking";
  opmerking: string | null;
  naam: string | null;
  tijd: Date;
}

export class Audit {
  constructor(private readonly pool: pg.Pool) {}

  controle(id: string): Controle | undefined {
    return CONTROLES.find((c) => c.id === id);
  }

  async bevindingen(admin: string, jaar: number, c: Controle, lonen: boolean): Promise<Array<Record<string, any>>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '30s'");
      const r = await client.query(`SELECT * FROM (${c.sql(lonen)}) q LIMIT 1000`, [admin, jaar]);
      await client.query("COMMIT");
      return r.rows;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** De geldende beoordeling per sleutel (de laatste). */
  async beoordelingen(admin: string, controle: string): Promise<Map<string, Beoordeling>> {
    const r = await this.pool.query<Beoordeling>(
      `SELECT DISTINCT ON (sleutel) sleutel, status, opmerking, naam, tijd
         FROM audit_beoordeling WHERE admin_key = $1 AND controle = $2
        ORDER BY sleutel, tijd DESC`,
      [admin, controle],
    );
    return new Map(r.rows.map((b) => [b.sleutel, b]));
  }

  async spoor(admin: string, controle: string, sleutel: string) {
    const r = await this.pool.query(
      `SELECT status, opmerking, naam, tijd FROM audit_beoordeling
        WHERE admin_key = $1 AND controle = $2 AND sleutel = $3 ORDER BY tijd DESC`,
      [admin, controle, sleutel],
    );
    return r.rows;
  }

  async beoordeel(o: { admin: string; controle: string; sleutel: string; status: string; opmerking: string; gebruikerId: number; naam: string }) {
    await this.pool.query(
      `INSERT INTO audit_beoordeling (admin_key, controle, sleutel, status, opmerking, gebruiker_id, naam)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [o.admin, o.controle, o.sleutel, o.status, o.opmerking || null, o.gebruikerId, o.naam],
    );
  }

  /** Samenvatting voor de auditpagina: per controle aantal bevindingen en open. */
  async samenvatting(admin: string, jaar: number, lonen: boolean) {
    const uit: Array<{ c: Controle; aantal: number; open: number; fout?: string }> = [];
    for (const c of CONTROLES) {
      try {
        const rijen = await this.bevindingen(admin, jaar, c, lonen);
        const b = await this.beoordelingen(admin, c.id);
        const open = rijen.filter((r) => b.get(String(r.sleutel))?.status !== "akkoord").length;
        uit.push({ c, aantal: rijen.length, open });
      } catch (e) {
        uit.push({ c, aantal: 0, open: 0, fout: e instanceof Error ? e.message : String(e) });
      }
    }
    return uit;
  }
}
