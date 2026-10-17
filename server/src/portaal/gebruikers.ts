import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { controleerTotp, controleerWachtwoord, hashWachtwoord } from "../auth.js";
import type { Kluis } from "../kluis.js";

export type Rol = "beheerder" | "aandeelhouder" | "accountant";

export interface Gebruiker {
  id: number;
  email: string;
  naam: string;
  rol: Rol;
  lonen: boolean;
  actief: boolean;
  sessie_versie: number;
  laatst_ingelogd: Date | null;
  aangemaakt: Date;
  uitnodiging_tot: Date | null;
  heeft_wachtwoord: boolean;
}

export interface Admin {
  admin_key: string;
  /** Korte naam voor in de URL: het databasenummer, of uniek gemaakt als dat op twee instances voorkomt. */
  slug: string;
  database_name: string;
  bedrijfsnaam: string | null;
  afgeschermd: boolean;
  laatst_sync: Date | null;
  bron: string | null;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const UITNODIGING_DAGEN = 7;
export const MIN_WACHTWOORD = 12;

const KOLOMMEN = `id, email, naam, rol, lonen, actief, sessie_versie, laatst_ingelogd, aangemaakt,
                  uitnodiging_tot, (wachtwoord_hash IS NOT NULL) AS heeft_wachtwoord`;

export class Gebruikers {
  constructor(
    private readonly pool: pg.Pool,
    private readonly kluis: Kluis,
  ) {}

  async aantalBeheerders(): Promise<number> {
    const r = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM portaal_gebruiker WHERE rol = 'beheerder' AND actief`,
    );
    return Number(r.rows[0]!.n);
  }

  async metId(id: number): Promise<Gebruiker | null> {
    const r = await this.pool.query<Gebruiker>(`SELECT ${KOLOMMEN} FROM portaal_gebruiker WHERE id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  async lijst(): Promise<Array<Gebruiker & { admins: string[] }>> {
    const r = await this.pool.query<Gebruiker & { admins: string[] }>(
      `SELECT ${KOLOMMEN},
              COALESCE((SELECT array_agg(admin_key ORDER BY admin_key) FROM portaal_toegang t WHERE t.gebruiker_id = g.id), '{}') AS admins
         FROM portaal_gebruiker g ORDER BY actief DESC, rol, naam`,
    );
    return r.rows;
  }

  /**
   * Maakt een account aan (of zet een bestaand account opnieuw klaar) en geeft
   * de uitnodigingscode terug. Die code staat alleen als hash in de database.
   * Een nieuwe uitnodiging maakt het oude wachtwoord en de oude TOTP ongeldig.
   */
  async uitnodigen(o: { email: string; naam: string; rol: Rol; lonen: boolean; admins: string[] }): Promise<{ id: number; code: string }> {
    const code = randomBytes(24).toString("base64url");
    const email = o.email.trim().toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const r = await client.query<{ id: number }>(
        `INSERT INTO portaal_gebruiker (email, naam, rol, lonen, uitnodiging_hash, uitnodiging_tot)
         VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
         ON CONFLICT (email) DO UPDATE
            SET naam = EXCLUDED.naam, rol = EXCLUDED.rol, lonen = EXCLUDED.lonen,
                uitnodiging_hash = EXCLUDED.uitnodiging_hash, uitnodiging_tot = EXCLUDED.uitnodiging_tot,
                wachtwoord_hash = NULL, totp_versleuteld = NULL, actief = false,
                sessie_versie = portaal_gebruiker.sessie_versie + 1
         RETURNING id`,
        [email, o.naam.trim(), o.rol, o.lonen, sha(code), UITNODIGING_DAGEN],
      );
      const id = r.rows[0]!.id;
      await client.query(`DELETE FROM portaal_toegang WHERE gebruiker_id = $1`, [id]);
      for (const a of o.admins) {
        await client.query(`INSERT INTO portaal_toegang (gebruiker_id, admin_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, a]);
      }
      await client.query("COMMIT");
      return { id, code };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async uitnodigingLezen(code: string): Promise<Gebruiker | null> {
    const r = await this.pool.query<Gebruiker>(
      `SELECT ${KOLOMMEN} FROM portaal_gebruiker WHERE uitnodiging_hash = $1 AND uitnodiging_tot > now()`,
      [sha(code)],
    );
    return r.rows[0] ?? null;
  }

  /** Rondt een uitnodiging af: wachtwoord en TOTP vastleggen, account actief. Eenmalig. */
  async activeren(code: string, wachtwoord: string, totpGeheim: string): Promise<Gebruiker | null> {
    const g = await this.uitnodigingLezen(code);
    if (!g) return null;
    const r = await this.pool.query<Gebruiker>(
      `UPDATE portaal_gebruiker
          SET wachtwoord_hash = $2, totp_versleuteld = $3, actief = true,
              uitnodiging_hash = NULL, uitnodiging_tot = NULL, sessie_versie = sessie_versie + 1
        WHERE id = $1 AND uitnodiging_hash = $4
      RETURNING ${KOLOMMEN}`,
      [g.id, hashWachtwoord(wachtwoord), this.kluis.versleutel(totpGeheim, `gebruiker:${g.id}`), sha(code)],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Inloggen. Altijd alle drie de controles, ook als het e-mailadres niet
   * bestaat, zodat de responstijd niet verraadt welke adressen een account hebben.
   */
  async inloggen(email: string, wachtwoord: string, code: string): Promise<Gebruiker | null> {
    const r = await this.pool.query<Gebruiker & { wachtwoord_hash: string | null; totp_versleuteld: string | null }>(
      `SELECT ${KOLOMMEN}, wachtwoord_hash, totp_versleuteld FROM portaal_gebruiker WHERE email = $1`,
      [email.trim().toLowerCase()],
    );
    const g = r.rows[0];
    const hash = g?.wachtwoord_hash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const wwOk = controleerWachtwoord(wachtwoord, hash);
    let codeOk = false;
    if (g?.totp_versleuteld) {
      try {
        codeOk = controleerTotp(this.kluis.ontsleutel(g.totp_versleuteld, `gebruiker:${g.id}`), code);
      } catch {
        codeOk = false;
      }
    }
    if (!g || !g.actief || !wwOk || !codeOk) return null;
    await this.pool.query(`UPDATE portaal_gebruiker SET laatst_ingelogd = now() WHERE id = $1`, [g.id]);
    const { wachtwoord_hash: _w, totp_versleuteld: _t, ...schoon } = g;
    return schoon;
  }

  /** Alleen de tweede factor, voor een verse bevestiging (OAuth-toestemming). */
  async totpKlopt(id: number, code: string): Promise<boolean> {
    const r = await this.pool.query<{ totp_versleuteld: string | null }>(
      `SELECT totp_versleuteld FROM portaal_gebruiker WHERE id = $1 AND actief`,
      [id],
    );
    const v = r.rows[0]?.totp_versleuteld;
    if (!v) return false;
    try {
      return controleerTotp(this.kluis.ontsleutel(v, `gebruiker:${id}`), code);
    } catch {
      return false;
    }
  }

  async wijzigen(id: number, o: { rol: Rol; lonen: boolean; admins: string[] }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE portaal_gebruiker SET rol = $2, lonen = $3 WHERE id = $1`, [id, o.rol, o.lonen]);
      await client.query(`DELETE FROM portaal_toegang WHERE gebruiker_id = $1`, [id]);
      for (const a of o.admins) {
        await client.query(`INSERT INTO portaal_toegang (gebruiker_id, admin_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, a]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Alle lopende sessies van deze gebruiker ongeldig maken. */
  async intrekken(id: number): Promise<void> {
    await this.pool.query(`UPDATE portaal_gebruiker SET sessie_versie = sessie_versie + 1 WHERE id = $1`, [id]);
  }

  /** Uitschakelen: account blijft (voor het logboek), alle sessies vervallen. */
  async uitschakelen(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE portaal_gebruiker SET actief = false, sessie_versie = sessie_versie + 1,
              uitnodiging_hash = NULL, uitnodiging_tot = NULL WHERE id = $1`,
      [id],
    );
  }

  /** De administraties die deze gebruiker mag zien. Beheerder: alle. */
  async admins(g: Gebruiker): Promise<Admin[]> {
    const r =
      g.rol === "beheerder"
        ? await this.pool.query<Admin>(
            `SELECT a.admin_key, a.database_name, a.bedrijfsnaam, a.afgeschermd, a.laatst_sync, a.bron,
                    CASE WHEN count(*) OVER (PARTITION BY a.database_name) > 1
                         THEN a.database_name || '-' || substr(md5(a.admin_key), 1, 4) ELSE a.database_name END AS slug
               FROM globe_admin a ORDER BY a.database_name, a.admin_key`,
          )
        : await this.pool.query<Admin>(
            `SELECT * FROM (
               SELECT a.admin_key, a.database_name, a.bedrijfsnaam, a.afgeschermd, a.laatst_sync, a.bron,
                      CASE WHEN count(*) OVER (PARTITION BY a.database_name) > 1
                         THEN a.database_name || '-' || substr(md5(a.admin_key), 1, 4) ELSE a.database_name END AS slug
                 FROM globe_admin a) a
               JOIN portaal_toegang t ON t.admin_key = a.admin_key AND t.gebruiker_id = $1
              ORDER BY a.database_name, a.admin_key`,
            [g.id],
          );
    return r.rows;
  }

  async log(o: { g?: Gebruiker | null; email?: string; actie: string; admin?: string | null; pad?: string; ip?: string; detail?: unknown }): Promise<void> {
    await this.pool
      .query(
        `INSERT INTO portaal_log (gebruiker_id, email, actie, admin_key, pad, ip, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [o.g?.id ?? null, o.g?.email ?? o.email ?? null, o.actie, o.admin ?? null, o.pad ?? null, o.ip ?? null, o.detail ? JSON.stringify(o.detail) : null],
      )
      .catch((e) => console.error("[log]", e));
  }
}
