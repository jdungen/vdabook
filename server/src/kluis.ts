import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Versleuteling van de TOTP-geheimen van portaalgebruikers. Een gelekte
 * databasedump levert daarmee geen tweede factor op; het kluisgeheim
 * (SLEUTEL_KLUIS) staat alleen in de omgeving van de service.
 *
 * AES-256-GCM: geauthenticeerd, dus een gewijzigde rij in de database geeft
 * een fout in plaats van een verminkt geheim. Het gebruikers-id gaat als extra
 * gegevens mee, zodat een geheim niet onder een ander account teruggezet kan
 * worden.
 */

const VERSIE = "v1";

export class Kluis {
  private readonly sleutel: Buffer;

  /**
   * Het geheim mag elke lange string zijn; SHA-256 maakt er 32 bytes van.
   * Kort is gevaarlijk, dus onder de 32 tekens weigeren we.
   */
  constructor(geheim: string) {
    if (geheim.length < 32) {
      throw new Error("SLEUTEL_KLUIS is korter dan 32 tekens.");
    }
    this.sleutel = createHash("sha256").update(geheim, "utf8").digest();
  }

  versleutel(tekst: string, context: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.sleutel, iv);
    c.setAAD(Buffer.from(context, "utf8"));
    const ct = Buffer.concat([c.update(tekst, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    return [VERSIE, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
  }

  ontsleutel(opgeslagen: string, context: string): string {
    const [versie, iv, tag, ct] = opgeslagen.split(":");
    if (versie !== VERSIE || !iv || !tag || ct === undefined) {
      throw new Error("Onbekend kluisformaat.");
    }
    const d = createDecipheriv("aes-256-gcm", this.sleutel, Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(context, "utf8"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
  }
}

/** Een vers geheim om als SLEUTEL_KLUIS in te stellen. */
export function nieuwKluisGeheim(): string {
  return randomBytes(32).toString("base64url");
}

