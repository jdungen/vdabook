import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Inloggen, sessies en tweede factor.
 *
 * De vorige opzet was HTTP Basic met één wachtwoord in een omgevingsvariabele.
 * Dat wachtwoord ging bij elk verzoek mee, stond in platte tekst, kende geen
 * sessie en dus geen uitloggen, en — het ergste — het maakte elk formulier
 * kwetsbaar voor CSRF: bij Basic auth stuurt de browser de credentials
 * automatisch mee, dus een willekeurige andere website kon een POST naar
 * /boeken/afvinken laten uitvoeren met Jans rechten.
 *
 * Alles hieronder gebruikt uitsluitend de crypto-module van Node. Voor een
 * dienst die in een boekhouding schrijft is een afhankelijkheid minder een
 * aanvalsvlak minder, en scrypt en HMAC zitten al in het platform.
 */

/* ------------------------------------------------------------ wachtwoorden */

/**
 * scrypt-parameters. N=32768 kost ongeveer 32 MB en een tiende seconde per
 * poging; dat is verwaarloosbaar bij één inlog per dag en vervelend genoeg
 * voor iemand die een gestolen hash wil doorrekenen.
 */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LEN = 32;

/**
 * Node weigert scrypt boven 32 MB en deze parameters vragen er precies 32 MB
 * (128·N·r), dus zonder deze grens op te rekken faalt élke hash met
 * "memory limit exceeded". Ruim nemen, het is een bovengrens en geen reservering.
 */
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

/** Maakt een opslagbare hash: `scrypt$N$r$p$zout$hash`, alles base64url. */
export function hashWachtwoord(wachtwoord: string): string {
  const zout = randomBytes(16);
  const hash = scryptSync(wachtwoord.normalize("NFKC"), zout, SCRYPT_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    zout.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/**
 * Controleert een wachtwoord tegen een opgeslagen hash.
 *
 * Vergelijkt in constante tijd. Een fout in het formaat levert `false` op en
 * geen uitzondering: een kapotte omgevingsvariabele hoort een mislukte inlog
 * te zijn, niet een stacktrace op het scherm.
 */
export function controleerWachtwoord(wachtwoord: string, opgeslagen: string): boolean {
  try {
    const [soort, n, r, p, zout, verwacht] = opgeslagen.split("$");
    if (soort !== "scrypt" || !zout || !verwacht) return false;

    const berekend = scryptSync(
      wachtwoord.normalize("NFKC"),
      Buffer.from(zout, "base64url"),
      Buffer.from(verwacht, "base64url").length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM },
    );
    return gelijk(berekend, Buffer.from(verwacht, "base64url"));
  } catch {
    return false;
  }
}

/** Vergelijking in constante tijd die niet struikelt over ongelijke lengtes. */
function gelijk(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------- TOTP */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function nieuwTotpSecret(bytes = 20): string {
  const ruw = randomBytes(bytes);
  let bits = "";
  for (const b of ruw) bits += b.toString(2).padStart(8, "0");
  let uit = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    uit += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return uit;
}

function base32Decode(s: string): Buffer {
  const schoon = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const teken of schoon) {
    const i = BASE32.indexOf(teken);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Eén TOTP-code volgens RFC 6238: HMAC-SHA1, zes cijfers, stappen van 30 s. */
export function totpCode(secretBase32: string, teller: number): string {
  const sleutel = base32Decode(secretBase32);
  const bericht = Buffer.alloc(8);
  bericht.writeBigUInt64BE(BigInt(teller));

  const mac = createHmac("sha1", sleutel).update(bericht).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binair =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  return String(binair % 1_000_000).padStart(6, "0");
}

/**
 * Controleert een ingetikte code, met één stap speling naar voren en naar
 * achteren. Die speling is er omdat de klok van een telefoon zelden precies
 * gelijkloopt; zonder marge wordt inloggen een kwestie van geluk rond de
 * seconde waarop de code wisselt.
 */
export function controleerTotp(
  secretBase32: string,
  code: string,
  nu = Date.now(),
): boolean {
  const schoon = (code ?? "").replace(/\D/g, "");
  if (schoon.length !== 6) return false;

  const teller = Math.floor(nu / 1000 / 30);
  for (const stap of [-1, 0, 1]) {
    const verwacht = totpCode(secretBase32, teller + stap);
    if (gelijk(Buffer.from(verwacht), Buffer.from(schoon))) return true;
  }
  return false;
}

/** De otpauth-URI die een authenticator-app als QR-code inleest. */
export function otpauthUri(secret: string, account: string, uitgever: string): string {
  const e = encodeURIComponent;
  return (
    `otpauth://totp/${e(uitgever)}:${e(account)}` +
    `?secret=${secret}&issuer=${e(uitgever)}&algorithm=SHA1&digits=6&period=30`
  );
}

