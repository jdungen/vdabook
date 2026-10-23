-- Globe-spiegel: read-only kopie van de Exact Globe-administraties op de pc bij
-- Van Dungen Automaten. Idempotent; draait bij elke start.

CREATE TABLE IF NOT EXISTS globe_admin (
  admin_key     text PRIMARY KEY,          -- "<instance>/<database>", bv. DESKTOP-1QOV41P\SQLEXPRESS/001
  database_name text NOT NULL,
  bedrijfsnaam  text,
  afgeschermd   boolean NOT NULL DEFAULT false,  -- bv. Van Dungen Pensioen: niet via lees-API tenzij expliciet gevraagd
  eerst_gezien  timestamptz NOT NULL DEFAULT now(),
  laatst_sync   timestamptz
);
ALTER TABLE globe_admin ADD COLUMN IF NOT EXISTS bron text;   -- SQL Server-instance zoals de agent hem zag

-- Eén rij per bronrij, als JSONB. Schema-agnostisch: een Globe-update met extra
-- kolommen breekt niets.
CREATE TABLE IF NOT EXISTS globe_row (
  admin_key  text NOT NULL REFERENCES globe_admin(admin_key) ON DELETE CASCADE,
  tbl        text NOT NULL,
  pk         text NOT NULL,
  data       jsonb NOT NULL,
  synced_at  timestamptz NOT NULL DEFAULT now(),
  eerst_gezien timestamptz NOT NULL DEFAULT now(),
  versies    int NOT NULL DEFAULT 1,
  PRIMARY KEY (admin_key, tbl, pk)
);
ALTER TABLE globe_row ADD COLUMN IF NOT EXISTS eerst_gezien timestamptz NOT NULL DEFAULT now();
ALTER TABLE globe_row ADD COLUMN IF NOT EXISTS versies int NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS globe_row_eerst ON globe_row (admin_key, tbl, eerst_gezien DESC);

-- Wat Globe achteraf wijzigt of weghaalt blijft hier staan: de oude versie van
-- de rij, met het moment waarop de spiegel het merkte. Dit is wat de zwarte
-- doos open maakt — een boeking die na de feiten is aangepast is zichtbaar.
CREATE TABLE IF NOT EXISTS globe_row_historie (
  id         bigserial PRIMARY KEY,
  admin_key  text NOT NULL REFERENCES globe_admin(admin_key) ON DELETE CASCADE,
  tbl        text NOT NULL,
  pk         text NOT NULL,
  soort      text NOT NULL CHECK (soort IN ('gewijzigd', 'verwijderd')),
  data_oud   jsonb NOT NULL,
  data_nieuw jsonb,
  gemerkt_op timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS globe_row_historie_tijd ON globe_row_historie (admin_key, tbl, gemerkt_op DESC);
CREATE INDEX IF NOT EXISTS globe_row_historie_pk ON globe_row_historie (admin_key, tbl, pk);

-- Watermerk per tabel. De server is de bron van waarheid, zodat de agent zelf
-- geen staat hoeft te bewaren en een afgebroken run gewoon opnieuw begint.
CREATE TABLE IF NOT EXISTS globe_sync_state (
  admin_key     text NOT NULL REFERENCES globe_admin(admin_key) ON DELETE CASCADE,
  tbl           text NOT NULL,
  strategie     text NOT NULL,             -- rowversion | sysmodified | volledig
  watermerk     text,
  sleutel       jsonb,                     -- primaire-sleutelkolommen
  kolommen      jsonb,
  laatst_rijen  timestamptz,
  laatst_sleutelscan timestamptz,
  bron_aantal   bigint,
  initieel_klaar timestamptz,              -- eerste volledige lading binnen; daarna telt een rij als 'nieuw'
  PRIMARY KEY (admin_key, tbl)
);
ALTER TABLE globe_sync_state ADD COLUMN IF NOT EXISTS initieel_klaar timestamptz;

-- Tijdelijke sleutellijst voor het verwerken van verwijderingen.
CREATE TABLE IF NOT EXISTS globe_keyscan (
  scan_id    text NOT NULL,
  admin_key  text NOT NULL,
  tbl        text NOT NULL,
  pk         text NOT NULL,
  aangemaakt timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scan_id, pk)
);

-- Afgeronde sleutelscans. Een herhaald laatste blok (time-out bij de agent,
-- daarna opnieuw verstuurd) krijgt hier het eerdere resultaat terug in plaats
-- van een tweede verwerking.
CREATE TABLE IF NOT EXISTS globe_keyscan_klaar (
  scan_id    text PRIMARY KEY,
  admin_key  text NOT NULL,
  tbl        text NOT NULL,
  resultaat  jsonb NOT NULL,
  afgerond   timestamptz NOT NULL DEFAULT now()
);

-- Eenmalige beheerhandelingen die via een variabele worden aangestuurd; de
-- sleutel bevat de waarde, zodat een herstart ze niet opnieuw uitvoert.
CREATE TABLE IF NOT EXISTS app_eenmalig (
  sleutel    text PRIMARY KEY,
  uitgevoerd timestamptz NOT NULL DEFAULT now(),
  resultaat  text
);

CREATE TABLE IF NOT EXISTS globe_run (
  id          bigserial PRIMARY KEY,
  agent       text NOT NULL,
  host        text,
  versie      text,
  gestart     timestamptz NOT NULL DEFAULT now(),
  geeindigd   timestamptz,
  ok          boolean,
  detail      jsonb
);
CREATE INDEX IF NOT EXISTS globe_run_gestart ON globe_run (gestart DESC);

-- Getypeerde kopie van de grootboekmutaties (Globe: gbkmut), bijgehouden door
-- een trigger op globe_row. De JSON-spiegel blijft de bron; dit is er alleen
-- zodat balans, W&V en de audit op honderdduizenden regels snel blijven.
CREATE OR REPLACE FUNCTION vda_num(t text) RETURNS numeric LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN t ~ '^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$' THEN t::numeric END $$;
CREATE OR REPLACE FUNCTION vda_int(t text) RETURNS int LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN t ~ '^\s*-?\d{1,9}\s*$' THEN t::int END $$;
CREATE OR REPLACE FUNCTION vda_datum(t text) RETURNS date LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN t ~ '^\d{4}-\d{2}-\d{2}' THEN substr(t, 1, 10)::date END $$;
CREATE OR REPLACE FUNCTION vda_tijd(t text) RETURNS timestamp LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN t ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN substr(t, 1, 19)::timestamp END $$;

CREATE TABLE IF NOT EXISTS gb_mutatie (
  admin_key    text NOT NULL,
  pk           text NOT NULL,
  boekjaar     int,
  periode      int,
  dagboek      text,
  boekstuk     text,
  grootboek    text,
  datum        date,
  omschrijving text,
  bedrag       numeric,
  debiteur     text,
  crediteur    text,
  factuurnr    text,
  kostenplaats text,
  btw_code     text,
  transtype    text,
  gebruiker    text,       -- Globe syscreator (wie heeft het geboekt)
  geboekt_op   timestamp,  -- Globe syscreated (wanneer ingevoerd)
  PRIMARY KEY (admin_key, pk)
);
CREATE INDEX IF NOT EXISTS gb_mutatie_jaar ON gb_mutatie (admin_key, boekjaar, grootboek);
CREATE INDEX IF NOT EXISTS gb_mutatie_rek ON gb_mutatie (admin_key, grootboek, datum);
CREATE INDEX IF NOT EXISTS gb_mutatie_stuk ON gb_mutatie (admin_key, dagboek, boekstuk);
CREATE INDEX IF NOT EXISTS gb_mutatie_rel ON gb_mutatie (admin_key, debiteur, crediteur);

CREATE OR REPLACE FUNCTION vda_gb_sync() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.tbl = 'gbkmut' THEN DELETE FROM gb_mutatie WHERE admin_key = OLD.admin_key AND pk = OLD.pk; END IF;
    RETURN OLD;
  END IF;
  IF NEW.tbl <> 'gbkmut' THEN RETURN NEW; END IF;
  d := NEW.data;
  INSERT INTO gb_mutatie VALUES (
    NEW.admin_key, NEW.pk,
    vda_int(d->>'bkjrcode'), vda_int(d->>'periode'),
    nullif(trim(d->>'dagbknr'), ''), nullif(trim(d->>'bkstnr'), ''), nullif(trim(d->>'reknr'), ''),
    vda_datum(d->>'datum'), d->>'oms25', vda_num(d->>'bdr_hfl'),
    nullif(trim(d->>'debnr'), ''), nullif(trim(d->>'crdnr'), ''), nullif(trim(d->>'faktuurnr'), ''),
    nullif(trim(d->>'kstplcode'), ''), nullif(trim(d->>'btw_code'), ''), nullif(trim(d->>'transtype'), ''),
    nullif(trim(d->>'syscreator'), ''), vda_tijd(d->>'syscreated'))
  ON CONFLICT (admin_key, pk) DO UPDATE SET
    boekjaar = EXCLUDED.boekjaar, periode = EXCLUDED.periode, dagboek = EXCLUDED.dagboek, boekstuk = EXCLUDED.boekstuk,
    grootboek = EXCLUDED.grootboek, datum = EXCLUDED.datum, omschrijving = EXCLUDED.omschrijving, bedrag = EXCLUDED.bedrag,
    debiteur = EXCLUDED.debiteur, crediteur = EXCLUDED.crediteur, factuurnr = EXCLUDED.factuurnr,
    kostenplaats = EXCLUDED.kostenplaats, btw_code = EXCLUDED.btw_code, transtype = EXCLUDED.transtype,
    gebruiker = EXCLUDED.gebruiker, geboekt_op = EXCLUDED.geboekt_op;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS globe_row_gb ON globe_row;
CREATE TRIGGER globe_row_gb AFTER INSERT OR UPDATE OR DELETE ON globe_row
  FOR EACH ROW EXECUTE FUNCTION vda_gb_sync();

-- Eenmalig bijwerken voor rijen die er al stonden voordat de trigger bestond.
INSERT INTO gb_mutatie
SELECT r.admin_key, r.pk, vda_int(r.data->>'bkjrcode'), vda_int(r.data->>'periode'),
       nullif(trim(r.data->>'dagbknr'), ''), nullif(trim(r.data->>'bkstnr'), ''), nullif(trim(r.data->>'reknr'), ''),
       vda_datum(r.data->>'datum'), r.data->>'oms25', vda_num(r.data->>'bdr_hfl'),
       nullif(trim(r.data->>'debnr'), ''), nullif(trim(r.data->>'crdnr'), ''), nullif(trim(r.data->>'faktuurnr'), ''),
       nullif(trim(r.data->>'kstplcode'), ''), nullif(trim(r.data->>'btw_code'), ''), nullif(trim(r.data->>'transtype'), ''),
       nullif(trim(r.data->>'syscreator'), ''), vda_tijd(r.data->>'syscreated')
  FROM globe_row r
 WHERE r.tbl = 'gbkmut'
   AND NOT EXISTS (SELECT 1 FROM gb_mutatie m WHERE m.admin_key = r.admin_key AND m.pk = r.pk);

DROP VIEW IF EXISTS v_grootboekmutaties;
CREATE VIEW v_grootboekmutaties AS
SELECT m.*, a.bedrijfsnaam, a.afgeschermd
  FROM gb_mutatie m JOIN globe_admin a USING (admin_key);

CREATE OR REPLACE VIEW v_grootboekrekeningen AS
SELECT r.admin_key,
       a.bedrijfsnaam,
       trim(r.data->>'reknr')   AS grootboek,
       r.data->>'oms25_0'       AS omschrijving,
       r.data->>'bal_vw'        AS balans_of_wv,
       r.data->>'debcrd'        AS debet_credit,
       r.data
  FROM globe_row r JOIN globe_admin a USING (admin_key)
 WHERE r.tbl = 'grtbk';

CREATE OR REPLACE VIEW v_relaties AS
SELECT r.admin_key,
       a.bedrijfsnaam,
       r.data->>'cmp_wwn'                       AS id,
       nullif(trim(r.data->>'cmp_code'), '')    AS code,
       r.data->>'cmp_name'                      AS naam,
       nullif(trim(r.data->>'debnr'), '')       AS debiteur,
       nullif(trim(r.data->>'crdnr'), '')       AS crediteur,
       r.data->>'cmp_type'                      AS soort,
       r.data
  FROM globe_row r JOIN globe_admin a USING (admin_key)
 WHERE r.tbl = 'cicmpy';
--
-- claude.ai kan geen vaste bearer token meesturen, alleen OAuth. Daarom is het
-- MCP-proces ook een kleine autorisatieserver. De toestemming zelf geeft een
-- mens op core, achter de inlog plus een verse TOTP-code; core schrijft alleen
-- het besluit op een verzoek. Codes en tokens staan hier uitsluitend als
-- SHA-256-hash: een gelekte databasedump levert geen bruikbare token op.

CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id   TEXT        PRIMARY KEY,
    info        JSONB       NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_verzoeken (
    id_hash         TEXT        PRIMARY KEY,
    client_id       TEXT        NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    redirect_uri    TEXT        NOT NULL,
    state           TEXT,
    code_challenge  TEXT        NOT NULL,
    scopes          TEXT[]      NOT NULL,
    resource        TEXT,
    status          TEXT        NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'goedgekeurd', 'geweigerd', 'afgehandeld')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    verloopt_op     TIMESTAMPTZ NOT NULL,
    beslist_op      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash       TEXT        PRIMARY KEY,
    client_id       TEXT        NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    redirect_uri    TEXT        NOT NULL,
    code_challenge  TEXT        NOT NULL,
    scopes          TEXT[]      NOT NULL,
    resource        TEXT,
    -- Alle tokens die uit deze code voortkomen delen de familie; bij misbruik
    -- (hergebruikte code of refresh token) gaat de hele familie dicht.
    familie         UUID        NOT NULL DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    verloopt_op     TIMESTAMPTZ NOT NULL,
    gebruikt_op     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash      TEXT        PRIMARY KEY,
    soort           TEXT        NOT NULL CHECK (soort IN ('access', 'refresh')),
    client_id       TEXT        NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    familie         UUID        NOT NULL,
    scopes          TEXT[]      NOT NULL,
    resource        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    verloopt_op     TIMESTAMPTZ NOT NULL,
    ingetrokken_op  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS oauth_tokens_familie_idx ON oauth_tokens (familie);


-- ------------------------------------------------------------------ portaal
-- Accounts voor aandeelhouders en accountant. Wachtwoord als scrypt-hash,
-- TOTP-geheim versleuteld (AES-256-GCM, SLEUTEL_KLUIS). Uitnodigingen als
-- SHA-256-hash; de link zelf bestaat alleen bij wie hem kreeg.

CREATE TABLE IF NOT EXISTS portaal_gebruiker (
  id                 serial PRIMARY KEY,
  email              text NOT NULL UNIQUE,          -- altijd kleine letters
  naam               text NOT NULL,
  rol                text NOT NULL CHECK (rol IN ('beheerder', 'aandeelhouder', 'accountant')),
  lonen              boolean NOT NULL DEFAULT false, -- mag loon- en personeelsgegevens zien
  wachtwoord_hash    text,
  totp_versleuteld   text,
  actief             boolean NOT NULL DEFAULT false,
  sessie_versie      int NOT NULL DEFAULT 1,
  uitnodiging_hash   text,
  uitnodiging_tot    timestamptz,
  aangemaakt         timestamptz NOT NULL DEFAULT now(),
  laatst_ingelogd    timestamptz
);

CREATE TABLE IF NOT EXISTS portaal_toegang (
  gebruiker_id int NOT NULL REFERENCES portaal_gebruiker(id) ON DELETE CASCADE,
  admin_key    text NOT NULL REFERENCES globe_admin(admin_key) ON DELETE CASCADE,
  PRIMARY KEY (gebruiker_id, admin_key)
);

-- Wie heeft wat bekeken, geëxporteerd of beoordeeld. Alleen toevoegen.
CREATE TABLE IF NOT EXISTS portaal_log (
  id           bigserial PRIMARY KEY,
  tijd         timestamptz NOT NULL DEFAULT now(),
  gebruiker_id int REFERENCES portaal_gebruiker(id) ON DELETE SET NULL,
  email        text,
  actie        text NOT NULL,
  admin_key    text,
  pad          text,
  ip           text,
  detail       jsonb
);
CREATE INDEX IF NOT EXISTS portaal_log_tijd ON portaal_log (tijd DESC);

-- Beoordelingen op auditbevindingen. Alleen toevoegen: de laatste per
-- (administratie, controle, sleutel) is de geldende, de rest is het spoor.
CREATE TABLE IF NOT EXISTS audit_beoordeling (
  id           bigserial PRIMARY KEY,
  admin_key    text NOT NULL REFERENCES globe_admin(admin_key) ON DELETE CASCADE,
  controle     text NOT NULL,
  sleutel      text NOT NULL,
  status       text NOT NULL CHECK (status IN ('akkoord', 'vraag', 'afwijking')),
  opmerking    text,
  gebruiker_id int REFERENCES portaal_gebruiker(id) ON DELETE SET NULL,
  naam         text,
  tijd         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_beoordeling_sleutel ON audit_beoordeling (admin_key, controle, sleutel, tijd DESC);

-- Referentiecijfers uit de (concept)jaarrekening, om de spiegel op aan te
-- sluiten. Gevuld vanuit de omgeving (JAARREKENING_REF), niet uit de repo.
-- bedrijf = stuk van de bedrijfsnaam; post = resultaat | activa | liquide |
-- eigen_vermogen | rc:<trefwoord andere administratie> (positief = vordering).
CREATE TABLE IF NOT EXISTS jaarrekening_ref (
  bedrijf  text NOT NULL,
  jaar     int  NOT NULL,
  post     text NOT NULL,
  bedrag   numeric NOT NULL,
  bron     text,
  PRIMARY KEY (bedrijf, jaar, post)
);
