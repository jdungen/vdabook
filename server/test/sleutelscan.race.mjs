// Reproduceert het incident van 22 oktober: het laatste blok van een sleutelscan
// komt meerdere keren tegelijk binnen (time-out bij de agent, daarna opnieuw).
// Vereist een lege test-Postgres in TEST_DATABASE_URL; draait niet in `npm test`.
import assert from "node:assert/strict";
import { Store } from "../dist/store.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.log("TEST_DATABASE_URL ontbreekt; overgeslagen"); process.exit(0); }

const N = Number(process.env.N ?? 200_000);
const RUN = Date.now().toString(36);
const ADMIN = "001@test";
const store = new Store(url, null);
await store.migrate();
await store.pool.query(`DELETE FROM globe_admin WHERE admin_key = $1`, [ADMIN]);
await store.pool.query(`INSERT INTO globe_admin (admin_key, database_name) VALUES ($1, '001')`, [ADMIN]);
await store.pool.query(
  `INSERT INTO globe_sync_state (admin_key, tbl, strategie, watermerk) VALUES ($1, 'gbkmut', 'rowversion', '999')`, [ADMIN]);

async function vul() {
  await store.pool.query(`DELETE FROM globe_row WHERE admin_key = $1`, [ADMIN]);
  await store.pool.query(`DELETE FROM globe_row_historie WHERE admin_key = $1`, [ADMIN]);
  await store.pool.query(
    `INSERT INTO globe_row (admin_key, tbl, pk, data)
     SELECT $1, 'gbkmut', g::text, jsonb_build_object('id', g, 'oms25', 'regel ' || g, 'bdr_hfl', g % 997)
       FROM generate_series(1, $2) g`, [ADMIN, N]);
}

/** Stuurt alle sleutels behalve `weg`, in blokken; het laatste blok `keer` keer tegelijk. */
async function scan(scanId, weg, keer) {
  const blijft = [];
  for (let i = 1; i <= N; i++) if (!weg.has(i)) blijft.push(String(i));
  const blok = 20_000;
  for (let i = 0; i + blok < blijft.length; i += blok) {
    await store.sleutels(scanId, ADMIN, "gbkmut", blijft.slice(i, i + blok), false);
  }
  const rest = blijft.slice(Math.floor((blijft.length - 1) / blok) * blok);
  return Promise.all(Array.from({ length: keer }, () => store.sleutels(scanId, ADMIN, "gbkmut", rest, true)));
}

const tel = async (sql) => Number((await store.pool.query(sql, [ADMIN])).rows[0].n);
const rijen = () => tel(`SELECT count(*) AS n FROM globe_row WHERE admin_key = $1`);
const hist = () => tel(`SELECT count(*) AS n FROM globe_row_historie WHERE admin_key = $1 AND soort = 'verwijderd'`);

// 1. Echte verwijdering van 300 regels, laatste blok 6x tegelijk.
await vul();
const echt = new Set(Array.from({ length: 300 }, (_, i) => 1000 + i * 7));
let t = Date.now();
const res = await scan(`scan-1-${RUN}`, echt, 6);
console.log(`1: ${Date.now() - t} ms, antwoorden:`, res.map((r) => r.verwijderd + (r.overgeslagen ? "/" + r.overgeslagen.slice(0, 30) : "")).join(" | "));
assert.equal(await rijen(), N - 300, "precies 300 rijen weg");
assert.equal(await hist(), 300, "elke verwijdering in de historie");

// 2. Hetzelfde laatste blok nog eens, ruim na afronding: geen effect.
const opnieuw = await store.sleutels(`scan-1-${RUN}`, ADMIN, "gbkmut", ["1"], true);
assert.equal(opnieuw.verwijderd, 300, "herhaling krijgt het eerdere resultaat");
assert.equal(await rijen(), N - 300);

// 3. Verdachte scan: 5% ontbreekt. Grens is 2%: niets verwijderd.
await vul();
const veel = new Set(Array.from({ length: N * 0.05 }, (_, i) => i + 1));
const r3 = await scan(`scan-3-${RUN}`, veel, 3);
assert.ok(r3.every((r) => r.verwijderd === 0), "niets verwijderd boven de grens");
assert.equal(await rijen(), N);
assert.equal(await hist(), 0);

// 4. Geen keyscan-resten.
assert.equal(Number((await store.pool.query(`SELECT count(*) AS n FROM globe_keyscan`)).rows[0].n), 0);

console.log("sleutelscan: alle controles geslaagd");
await store.close();
