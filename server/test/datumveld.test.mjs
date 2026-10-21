import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { nlNaarIso, isoNaarNl, datumVeld, datumInvoerNaarIso } from "../dist/portaal/datumveld.js";

test("nlNaarIso: dd-mm-jjjj en varianten", () => {
  assert.equal(nlNaarIso("07-03-2026"), "2026-03-07");
  assert.equal(nlNaarIso("7-3-2026"), "2026-03-07");
  assert.equal(nlNaarIso("07/03/2026"), "2026-03-07");
  assert.equal(nlNaarIso(" 07.03.2026 "), "2026-03-07");
  assert.equal(nlNaarIso("29-02-2028"), "2028-02-29");
  assert.equal(nlNaarIso("31-02-2026"), null);
  assert.equal(nlNaarIso("2026-03-07"), null);
  assert.equal(nlNaarIso("onderhoud 07-03-2026"), null);
  assert.equal(nlNaarIso(""), null);
});

test("isoNaarNl", () => {
  assert.equal(isoNaarNl("2026-03-07"), "07-03-2026");
  assert.equal(isoNaarNl(new Date("2026-03-07T00:00:00Z")), "07-03-2026");
  assert.equal(isoNaarNl(null), "");
  assert.equal(isoNaarNl("onbekend"), "onbekend");
});

test("datumVeld toont dd-mm-jjjj en verstuurt alleen het tekstveld", () => {
  const h = datumVeld("datum", "2026-10-19", { required: true });
  assert.match(h, /type="text" name="datum" value="19-10-2026"/);
  assert.match(h, / required/);
  assert.match(h, /<input type="date" class="datumkiezer"[^>]*value="2026-10-19">/);
  assert.equal((h.match(/name=/g) ?? []).length, 1);
  assert.doesNotMatch(datumVeld("x\"y", "<b>"), /<b>|x"y/);
});

test("middleware: body en query naar ISO, script met nonce in pagina", async () => {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => ((req.nonce = "abc"), next()));
  app.use(datumInvoerNaarIso());
  app.post("/p", (req, res) => res.json(req.body));
  app.get("/q", (req, res) => res.json(req.query));
  app.get("/h", (_req, res) => res.send(`<html><body>${datumVeld("d", "2026-01-02")}</body></html>`));
  app.get("/zonder", (_req, res) => res.send("<html><body>niets</body></html>"));
  const srv = app.listen(0);
  const basis = `http://127.0.0.1:${srv.address().port}`;
  try {
    const p = await (await fetch(`${basis}/p`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "datum=19-10-2026&fout=31-02-2026&tekst=hallo&iso=2026-10-19" })).json();
    assert.deepEqual(p, { datum: "2026-10-19", fout: "31-02-2026", tekst: "hallo", iso: "2026-10-19" });
    const q = await (await fetch(`${basis}/q?periode=vrij&van=1-9-2026&tot=30-09-2026`)).json();
    assert.deepEqual(q, { periode: "vrij", van: "2026-09-01", tot: "2026-09-30" });
    const h = await (await fetch(`${basis}/h`)).text();
    assert.match(h, /<script nonce="abc">.*showPicker.*<\/script><\/body>/s);
    const z = await (await fetch(`${basis}/zonder`)).text();
    const app2 = express();
    app2.use(datumInvoerNaarIso(() => undefined));
    app2.get("/h", (_req, res) => res.send(`<html><body>${datumVeld("d", "2026-01-02")}</body></html>`));
    const srv2 = app2.listen(0);
    const g = await (await fetch(`http://127.0.0.1:${srv2.address().port}/h`)).text();
    srv2.close();
    assert.doesNotMatch(g, /<script/);
    assert.match(g, /value="02-01-2026"/);
    assert.doesNotMatch(z, /<script/);
  } finally {
    srv.close();
  }
});
