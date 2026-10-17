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

-- Handige views. Kolomnamen zijn die van Globe; ontbreekt er een in een
-- versie, dan is het veld NULL in plaats van dat de view breekt.
CREATE OR REPLACE VIEW v_grootboekmutaties AS
SELECT r.admin_key,
       a.bedrijfsnaam,
       a.afgeschermd,
       (r.data->>'bkjrcode')::int                 AS boekjaar,
       (r.data->>'periode')::int                  AS periode,
       r.data->>'dagbknr'                         AS dagboek,
       r.data->>'bkstnr'                          AS boekstuk,
       trim(r.data->>'reknr')                     AS grootboek,
       (r.data->>'datum')::date                   AS datum,
       r.data->>'oms25'                           AS omschrijving,
       (r.data->>'bdr_hfl')::numeric              AS bedrag,
       nullif(trim(r.data->>'debnr'), '')         AS debiteur,
       nullif(trim(r.data->>'crdnr'), '')         AS crediteur,
       nullif(trim(r.data->>'faktuurnr'), '')     AS factuurnr,
       nullif(trim(r.data->>'kstplcode'), '')     AS kostenplaats,
       r.data->>'btw_code'                        AS btw_code,
       r.data->>'transtype'                       AS transtype,
       r.data->>'transsubtype'                    AS transsubtype,
       r.data
  FROM globe_row r JOIN globe_admin a USING (admin_key)
 WHERE r.tbl = 'gbkmut';

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

