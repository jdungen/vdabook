# VDA Book

Inzicht in de Exact Globe+-administraties van de familiebedrijven (Van Dungen Automaten, Drie D Holding, STAK Familiefonds, Van Dungen Pensioen), voor aandeelhouders en accountant. Alleen lezen: er bestaat geen code-pad terug naar Globe.

```
[pc Automaten]                                  [Railway]
Exact Globe+ (SQL Server) -- agent --push-->  server/  (Postgres-spiegel, portaal, MCP)
```

- `server/agent/` — PowerShell-agent voor de Globe-pc. `Installeer.ps1` eenmalig als beheerder.
- `server/` — Node/Express op Railway (root `server/`): ontvangt de spiegel, portaal met accounts en audit, MCP voor Claude.
