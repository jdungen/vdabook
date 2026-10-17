<#
.SYNOPSIS
  VDA Book - Globe-sync-agent. Leest de Exact Globe-administraties op deze pc
  read-only en duwt ze naar de spiegel op Railway.

.DESCRIPTION
  Draait als geplande taak onder SYSTEM: bij opstarten en daarna elk half uur
  zolang de pc aanstaat. Alleen uitgaand HTTPS; deze pc hoeft van buitenaf
  nergens bereikbaar te zijn.

  - Vindt zelf de SQL Server-instances en daarin de Globe-databases.
  - Neemt alle tabellen mee. Per tabel kiest hij de zuinigste manier:
      rowversion   kolom van type timestamp/rowversion  -> alleen wat veranderd is
      sysmodified  kolom sysmodified                    -> idem, met 10 min overlap
      volledig     geen van beide                       -> alleen als de checksum wijzigt
  - Het watermerk staat op de server. Breekt een run af (pc uit), dan gaat de
    volgende verder waar het laatste geslaagde blok ophield.
  - Verwijderingen: periodiek een sleutelscan; de server haalt weg wat er niet
    meer is (met een veiligheidsgrens).
  - Kolommen met BSN/paspoort/wachtwoord verlaten deze pc nooit.

  Schrijft niets in Globe. De SQL-login heeft alleen db_datareader.

.PARAMETER ConfigPad
  Pad naar config.json (standaard C:\ProgramData\VDA-GlobeSync\config.json).
#>
[CmdletBinding()]
param(
  [string]$ConfigPad = "$env:ProgramData\VDA-GlobeSync\config.json"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$AgentVersie = '1.0.0'
$Map = Split-Path -Parent $ConfigPad
$LogMap = Join-Path $Map 'logs'
if (-not (Test-Path $LogMap)) { New-Item -ItemType Directory -Path $LogMap -Force | Out-Null }

# ---------------------------------------------------------------- logboek

$script:LogBestand = Join-Path $LogMap ("{0:yyyy-MM-dd}.log" -f (Get-Date))
function Log {
  param([string]$Tekst, [string]$Niveau = 'INFO')
  $regel = "{0:yyyy-MM-dd HH:mm:ss} [{1}] {2}" -f (Get-Date), $Niveau, $Tekst
  Add-Content -Path $script:LogBestand -Value $regel -Encoding UTF8
  if ($Host.Name -ne 'Default Host') { Write-Host $regel }
}

# Oude logbestanden opruimen (14 dagen).
Get-ChildItem $LogMap -Filter '*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
  Remove-Item -Force -ErrorAction SilentlyContinue

# ------------------------------------------------- een run tegelijk (mutex)

$mutex = New-Object System.Threading.Mutex($false, 'Global\VDA-GlobeSync')
if (-not $mutex.WaitOne(0)) {
  Log 'Er draait al een run; deze stopt.'
  exit 0
}

try {

# ------------------------------------------------------------------ config

if (-not (Test-Path $ConfigPad)) { throw "Config ontbreekt: $ConfigPad. Draai eerst Installeer.ps1." }
$cfg = Get-Content $ConfigPad -Raw -Encoding UTF8 | ConvertFrom-Json

Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Web.Extensions

function Lees-Token {
  if ($cfg.PSObject.Properties.Name -contains 'token_dpapi' -and $cfg.token_dpapi) {
    $bytes = [Convert]::FromBase64String($cfg.token_dpapi)
    $plat = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    return [Text.Encoding]::UTF8.GetString($plat)
  }
  if ($cfg.PSObject.Properties.Name -contains 'token' -and $cfg.token) { return [string]$cfg.token }
  throw 'Geen token in de config.'
}

$Endpoint = ([string]$cfg.endpoint).TrimEnd('/')
$Token = Lees-Token
$BlokRijen = 2000
if ($cfg.PSObject.Properties.Name -contains 'blok_rijen' -and $cfg.blok_rijen) { $BlokRijen = [int]$cfg.blok_rijen }
$BlokSleutels = 20000
$GeheimPatroon = '(?i)(socsec|sofi|^bsn|_bsn|bsn_|passport|paspoort|idcard|id_number|password|wachtwoord|^pwd|pincode)'
if ($cfg.PSObject.Properties.Name -contains 'geheim_patroon' -and $cfg.geheim_patroon) { $GeheimPatroon = [string]$cfg.geheim_patroon }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json.MaxJsonLength = [int]::MaxValue
$json.RecursionLimit = 100

# ------------------------------------------------------------------- HTTP

function Stuur {
  param([string]$Pad, $Inhoud)
  $tekst = $json.Serialize($Inhoud)
  $ruw = [Text.Encoding]::UTF8.GetBytes($tekst)
  $ms = New-Object IO.MemoryStream
  $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress)
  $gz.Write($ruw, 0, $ruw.Length); $gz.Close()
  $body = $ms.ToArray()

  $wachten = @(5, 20, 60, 120)
  for ($poging = 0; ; $poging++) {
    try {
      $req = [Net.HttpWebRequest]::Create("$Endpoint$Pad")
      $req.Method = 'POST'
      $req.ContentType = 'application/json; charset=utf-8'
      $req.Headers.Add('Content-Encoding', 'gzip')
      $req.Headers.Add('Authorization', "Bearer $Token")
      $req.UserAgent = "VDA-GlobeSync/$AgentVersie"
      $req.Timeout = 300000
      $req.ReadWriteTimeout = 300000
      $req.ContentLength = $body.Length
      $s = $req.GetRequestStream(); $s.Write($body, 0, $body.Length); $s.Close()
      $resp = $req.GetResponse()
      $rd = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
      $antwoord = $rd.ReadToEnd(); $rd.Close(); $resp.Close()
      return $json.DeserializeObject($antwoord)
    } catch [Net.WebException] {
      $status = 0; $foutTekst = $_.Exception.Message
      if ($_.Exception.Response) {
        $status = [int]$_.Exception.Response.StatusCode
        try { $foutTekst = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch { }
      }
      # 4xx (behalve 408/429) is een fout in het verzoek; opnieuw proberen helpt niet.
      if ($status -ge 400 -and $status -lt 500 -and $status -ne 408 -and $status -ne 429) {
        throw "HTTP $status op $Pad`: $foutTekst"
      }
      if ($poging -ge $wachten.Count) { throw "Server onbereikbaar na $($poging + 1) pogingen ($Pad): $foutTekst" }
      Log "HTTP-fout op $Pad ($status): $foutTekst - opnieuw over $($wachten[$poging]) s" 'WARN'
      Start-Sleep -Seconds $wachten[$poging]
    }
  }
}

# -------------------------------------------------------------------- SQL

function Open-Sql {
  param([string]$Server, [string]$Database = 'master')
  $cs = "Server=$Server;Database=$Database;Integrated Security=SSPI;Application Name=VDA-GlobeSync;Connect Timeout=30;Encrypt=False;TrustServerCertificate=True"
  $c = New-Object System.Data.SqlClient.SqlConnection($cs)
  $c.Open()
  return $c
}

function Sql-Tabel {
  param($Verbinding, [string]$Query, [hashtable]$Params = @{})
  $cmd = $Verbinding.CreateCommand()
  $cmd.CommandText = $Query
  $cmd.CommandTimeout = 600
  foreach ($k in $Params.Keys) { [void]$cmd.Parameters.AddWithValue($k, $Params[$k]) }
  $da = New-Object System.Data.SqlClient.SqlDataAdapter($cmd)
  $dt = New-Object System.Data.DataTable
  [void]$da.Fill($dt)
  return ,$dt
}

function Sql-Waarde {
  param($Verbinding, [string]$Query, [hashtable]$Params = @{})
  $cmd = $Verbinding.CreateCommand()
  $cmd.CommandText = $Query
  $cmd.CommandTimeout = 600
  foreach ($k in $Params.Keys) { [void]$cmd.Parameters.AddWithValue($k, $Params[$k]) }
  return $cmd.ExecuteScalar()
}

function Q([string]$naam) { return '[' + $naam.Replace(']', ']]') + ']' }

# Zet een SQL-waarde om naar iets dat stabiel als JSON reist.
function Naar-Json-Waarde($v) {
  if ($v -is [DBNull] -or $null -eq $v) { return $null }
  if ($v -is [datetime]) { return $v.ToString('yyyy-MM-ddTHH:mm:ss.fff') }
  if ($v -is [datetimeoffset]) { return $v.ToString('o') }
  if ($v -is [byte[]]) { return '0x' + [BitConverter]::ToString($v).Replace('-', '') }
  if ($v -is [guid]) { return $v.ToString() }
  if ($v -is [timespan]) { return $v.ToString() }
  if ($v -is [string]) { return $v.TrimEnd() }
  if ($v -is [decimal] -or $v -is [double] -or $v -is [single] -or $v -is [int] -or $v -is [long] -or $v -is [int16] -or $v -is [byte] -or $v -is [bool]) { return $v }
  return [string]$v
}

# -------------------------------------------------------------- ontdekken

function Vind-Instances {
  if ($cfg.PSObject.Properties.Name -contains 'instances' -and $cfg.instances) { return @($cfg.instances) }
  $lijst = @()
  $reg = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
  if (Test-Path $reg) {
    $namen = (Get-Item $reg).Property
    foreach ($n in $namen) {
      if ($n -eq 'MSSQLSERVER') { $lijst += '.' } else { $lijst += ".\$n" }
    }
  }
  return $lijst
}

# Typen die niet meegaan: binaire blobs (bijlagen, plaatjes) en ruimtelijke typen.
$OverslaanTypen = @('image', 'varbinary', 'binary', 'geography', 'geometry', 'hierarchyid', 'sql_variant')

function Lees-Tabellen {
  param($Verbinding)
  $t = Sql-Tabel $Verbinding @"
SELECT t.object_id, s.name AS schema_naam, t.name AS tabel,
       (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = t.object_id AND p.index_id IN (0,1)) AS rijen
  FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
 WHERE t.is_ms_shipped = 0
 ORDER BY t.name
"@
  $k = Sql-Tabel $Verbinding @"
SELECT c.object_id, c.column_id, c.name AS kolom, ty.name AS type, c.max_length
  FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
  JOIN sys.tables t ON t.object_id = c.object_id
 WHERE t.is_ms_shipped = 0
 ORDER BY c.object_id, c.column_id
"@
  $i = Sql-Tabel $Verbinding @"
SELECT i.object_id, i.index_id, i.is_primary_key, i.is_unique, ic.key_ordinal, c.name AS kolom
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  JOIN sys.tables t ON t.object_id = i.object_id
 WHERE t.is_ms_shipped = 0 AND (i.is_primary_key = 1 OR i.is_unique = 1) AND i.has_filter = 0
 ORDER BY i.object_id, i.is_primary_key DESC, i.index_id, ic.key_ordinal
"@
  $resultaat = @()
  foreach ($r in $t.Rows) {
    $oid = $r.object_id
    $kolommen = @($k.Select("object_id = $oid"))
    $rv = $null; $sysmod = $null; $mee = @()
    foreach ($c in $kolommen) {
      $type = [string]$c.type
      if ($type -eq 'timestamp' -or $type -eq 'rowversion') { $rv = [string]$c.kolom; continue }
      if ($OverslaanTypen -contains $type) { continue }
      if ([string]$c.kolom -match $GeheimPatroon) { continue }
      if (([string]$c.kolom).ToLower() -eq 'sysmodified' -and ($type -like '*date*')) { $sysmod = [string]$c.kolom }
      $mee += [string]$c.kolom
    }
    if ($mee.Count -eq 0) { continue }

    # Sleutel: primaire sleutel, anders de kleinste unieke index.
    $idx = @($i.Select("object_id = $oid"))
    $sleutel = @()
    if ($idx.Count -gt 0) {
      $eerste = $idx[0].index_id
      $sleutel = @($idx | Where-Object { $_.index_id -eq $eerste } | Sort-Object key_ordinal | ForEach-Object { [string]$_.kolom })
      # Een sleutelkolom die we niet meenemen (binair, geheim) maakt de sleutel onbruikbaar.
      foreach ($s in $sleutel) { if ($mee -notcontains $s) { $sleutel = @(); break } }
    }

    $strategie = 'volledig'
    if ($rv) { $strategie = 'rowversion' } elseif ($sysmod) { $strategie = 'sysmodified' }

    $resultaat += New-Object PSObject -Property @{
      schema    = [string]$r.schema_naam
      tbl       = ([string]$r.tabel).ToLower()
      naam      = [string]$r.tabel
      rijen     = [long]($(if ($r.rijen -is [DBNull]) { 0 } else { $r.rijen }))
      kolommen  = $mee
      sleutel   = $sleutel
      rv        = $rv
      sysmod    = $sysmod
      strategie = $strategie
    }
  }
  return $resultaat
}

function Rij-Sleutel {
  param($Lezer, [string[]]$Sleutel, [string[]]$Kolommen, $Data)
  if ($Sleutel.Count -gt 0) {
    return (($Sleutel | ForEach-Object { [string]$Data[$_.ToLower()] }) -join '|')
  }
  # Geen sleutel: een hash van de hele rij. Wijzigt er iets, dan is het voor de
  # spiegel een nieuwe rij en verdwijnt de oude bij de volgende sleutelscan.
  $sha = [Security.Cryptography.SHA1]::Create()
  $b = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json.Serialize($Data)))
  return 'h:' + [BitConverter]::ToString($b).Replace('-', '').ToLower()
}

# Leest een query en stuurt per blok door. Geeft het aantal rijen terug.
function Stroom {
  param($Verbinding, [string]$Query, [hashtable]$Params, $T, [string]$AdminKey, [scriptblock]$WatermerkVan, [switch]$WatermerkPerBlok)
  $cmd = $Verbinding.CreateCommand()
  $cmd.CommandText = $Query
  $cmd.CommandTimeout = 0
  foreach ($k in $Params.Keys) { [void]$cmd.Parameters.AddWithValue($k, $Params[$k]) }
  $lezer = $cmd.ExecuteReader()
  $namen = @(); for ($x = 0; $x -lt $lezer.FieldCount; $x++) { $namen += $lezer.GetName($x) }
  $blok = New-Object System.Collections.ArrayList
  $totaal = 0; $wm = $null
  try {
    while ($lezer.Read()) {
      $data = [ordered]@{}
      for ($x = 0; $x -lt $namen.Count; $x++) {
        if ($namen[$x] -eq '__wm') { $wm = & $WatermerkVan $lezer.GetValue($x); continue }
        $data[$namen[$x].ToLower()] = Naar-Json-Waarde ($lezer.GetValue($x))
      }
      [void]$blok.Add(@{ pk = (Rij-Sleutel $lezer $T.sleutel $T.kolommen $data); data = $data })
      if ($blok.Count -ge $BlokRijen) {
        $stuk = @{ admin_key = $AdminKey; tbl = $T.tbl; rijen = $blok.ToArray() }
        if ($WatermerkPerBlok -and $null -ne $wm) { $stuk.watermerk = [string]$wm }
        [void](Stuur '/agent/rijen' $stuk)
        $totaal += $blok.Count; $blok.Clear()
      }
    }
  } finally { $lezer.Close() }
  if ($blok.Count -gt 0 -or ($WatermerkPerBlok -and $null -ne $wm)) {
    $stuk = @{ admin_key = $AdminKey; tbl = $T.tbl; rijen = $blok.ToArray() }
    if ($WatermerkPerBlok -and $null -ne $wm) { $stuk.watermerk = [string]$wm }
    [void](Stuur '/agent/rijen' $stuk)
    $totaal += $blok.Count
  }
  return $totaal
}

function Sleutelscan {
  param($Verbinding, $T, [string]$AdminKey)
  $scan = [guid]::NewGuid().ToString()
  if ($T.sleutel.Count -gt 0) {
    $sel = ($T.sleutel | ForEach-Object { Q $_ }) -join ', '
  } else {
    $sel = ($T.kolommen | ForEach-Object { Q $_ }) -join ', '
  }
  $cmd = $Verbinding.CreateCommand()
  $cmd.CommandText = "SELECT $sel FROM $(Q $T.schema).$(Q $T.naam)"
  $cmd.CommandTimeout = 0
  $lezer = $cmd.ExecuteReader()
  $namen = @(); for ($x = 0; $x -lt $lezer.FieldCount; $x++) { $namen += $lezer.GetName($x) }
  $blok = New-Object System.Collections.ArrayList
  $n = 0
  try {
    while ($lezer.Read()) {
      $data = [ordered]@{}
      for ($x = 0; $x -lt $namen.Count; $x++) { $data[$namen[$x].ToLower()] = Naar-Json-Waarde ($lezer.GetValue($x)) }
      [void]$blok.Add((Rij-Sleutel $lezer $T.sleutel $T.kolommen $data))
      if ($blok.Count -ge $BlokSleutels) {
        [void](Stuur '/agent/sleutels' @{ scan_id = $scan; admin_key = $AdminKey; tbl = $T.tbl; sleutels = $blok.ToArray(); laatste = $false })
        $n += $blok.Count; $blok.Clear()
      }
    }
  } finally { $lezer.Close() }
  $n += $blok.Count
  $r = Stuur '/agent/sleutels' @{ scan_id = $scan; admin_key = $AdminKey; tbl = $T.tbl; sleutels = $blok.ToArray(); laatste = $true }
  if ($r['overgeslagen']) { Log "  $($T.tbl): $($r['overgeslagen'])" 'WARN' }
  elseif ([int]$r['verwijderd'] -gt 0) { Log "  $($T.tbl): $($r['verwijderd']) verwijderde rij(en) verwerkt" }
}

# --------------------------------------------------------------------- run

Log "Start run, agent $AgentVersie op $env:COMPUTERNAME"
$gestart = Get-Date
$fouten = New-Object System.Collections.ArrayList
$tellers = @{}

# Wacht kort op het netwerk na een herstart.
for ($w = 0; $w -lt 12; $w++) {
  try { [void][Net.Dns]::GetHostAddresses(([Uri]$Endpoint).Host); break } catch { Start-Sleep -Seconds 10 }
}

# 1. Ontdekken
$admins = @()
$plan = @{}
foreach ($inst in (Vind-Instances)) {
  try {
    $m = Open-Sql $inst
    $instNaam = [string](Sql-Waarde $m 'SELECT @@SERVERNAME')
    $dbs = Sql-Tabel $m "SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name"
    $m.Close()
    foreach ($d in $dbs.Rows) {
      $db = [string]$d.name
      try {
        $c = Open-Sql $inst $db
        $isGlobe = Sql-Waarde $c "SELECT CASE WHEN OBJECT_ID('dbo.gbkmut') IS NOT NULL AND OBJECT_ID('dbo.grtbk') IS NOT NULL THEN 1 ELSE 0 END"
        if ([int]$isGlobe -ne 1) { $c.Close(); continue }
        $naam = $null
        try { $naam = [string](Sql-Waarde $c "SELECT TOP 1 LTRIM(RTRIM(bedrnm)) FROM dbo.bedryf") } catch { }
        $tabellen = Lees-Tabellen $c
        $c.Close()
        $key = "$instNaam/$db"
        $admins += @{
          admin_key    = $key
          database     = $db
          bedrijfsnaam = $naam
          tabellen     = @($tabellen | ForEach-Object { @{ tbl = $_.tbl; strategie = $_.strategie; sleutel = $_.sleutel; kolommen = $_.kolommen; bron_aantal = $_.rijen } })
        }
        $plan[$key] = @{ instance = $inst; database = $db; tabellen = $tabellen }
        Log "Gevonden: $key ($naam), $($tabellen.Count) tabellen"
      } catch {
        Log "Database $db op $inst overgeslagen: $($_.Exception.Message)" 'WARN'
        [void]$fouten.Add("$inst/$db`: $($_.Exception.Message)")
      }
    }
  } catch {
    Log "Instance $inst niet bereikbaar: $($_.Exception.Message)" 'WARN'
    [void]$fouten.Add("$inst`: $($_.Exception.Message)")
  }
}

if ($admins.Count -eq 0) {
  Log 'Geen Globe-administraties gevonden of geen leesrechten. Controleer Installeer.ps1 (db_datareader).' 'ERROR'
}

# 2. Aanmelden bij de server: welke watermerken, wat overslaan
$start = Stuur '/agent/start' @{ agent = 'VDA-GlobeSync'; host = $env:COMPUTERNAME; versie = $AgentVersie; admins = $admins }
$runId = $start['run_id']
$toestand = $start['toestand']
$scanUren = [double]$start['sleutelscan_na_uren']
$klaar = New-Object System.Collections.ArrayList

# 3. Per administratie, per tabel
foreach ($key in $plan.Keys) {
  $p = $plan[$key]
  $adminOk = $true
  try { $c = Open-Sql $p.instance $p.database } catch {
    [void]$fouten.Add("$key`: $($_.Exception.Message)"); continue
  }
  try {
    # Grote tabellen het laatst, zodat kleine al bijgewerkt zijn als de pc halverwege uitgaat.
    foreach ($t in ($p.tabellen | Sort-Object rijen)) {
      $ts = $toestand[$key][$t.tbl]
      if ($null -eq $ts) { continue }
      if ($ts['overslaan']) { continue }
      $wm = $ts['watermerk']
      $bron = "$(Q $t.schema).$(Q $t.naam)"
      $sel = ($t.kolommen | ForEach-Object { Q $_ }) -join ', '
      try {
        $n = 0
        switch ($t.strategie) {
          'rowversion' {
            $grens = if ($wm) { [long]$wm } else { [long]-1 }
            $q = "SELECT $sel, CONVERT(bigint, $(Q $t.rv)) AS __wm FROM $bron WITH (NOLOCK) " +
                 "WHERE $(Q $t.rv) > CONVERT(binary(8), CAST(@wm AS bigint)) AND $(Q $t.rv) < MIN_ACTIVE_ROWVERSION() ORDER BY $(Q $t.rv)"
            if ($grens -lt 0) {
              $q = "SELECT $sel, CONVERT(bigint, $(Q $t.rv)) AS __wm FROM $bron WITH (NOLOCK) WHERE $(Q $t.rv) < MIN_ACTIVE_ROWVERSION() ORDER BY $(Q $t.rv)"
            }
            $n = Stroom $c $q @{ '@wm' = $grens } $t $key { param($v) [long]$v } -WatermerkPerBlok
          }
          'sysmodified' {
            $q = "SELECT $sel, $(Q $t.sysmod) AS __wm FROM $bron WITH (NOLOCK) "
            $params = @{}
            if ($wm) { $q += "WHERE $(Q $t.sysmod) >= DATEADD(minute, -10, @wm) "; $params['@wm'] = [datetime]::Parse($wm, [Globalization.CultureInfo]::InvariantCulture) }
            $q += "ORDER BY $(Q $t.sysmod)"
            $n = Stroom $c $q $params $t $key { param($v) if ($v -is [DBNull]) { $null } else { ([datetime]$v).ToString('yyyy-MM-ddTHH:mm:ss.fff') } } -WatermerkPerBlok
          }
          default {
            # Geen wijzigingskolom: alleen als de inhoud veranderd is, dan alles opnieuw.
            $som = Sql-Waarde $c "SELECT CAST(COUNT_BIG(*) AS varchar(20)) + ':' + CAST(ISNULL(CHECKSUM_AGG(BINARY_CHECKSUM(*)), 0) AS varchar(20)) FROM $bron WITH (NOLOCK)"
            if ([string]$som -ne [string]$wm) {
              $n = Stroom $c "SELECT $sel FROM $bron WITH (NOLOCK)" @{} $t $key { param($v) $null }
              Sleutelscan $c $t $key
              [void](Stuur '/agent/rijen' @{ admin_key = $key; tbl = $t.tbl; rijen = @(); watermerk = [string]$som })
            }
          }
        }
        # Verwijderingen opsporen bij tabellen met een wijzigingskolom.
        if ($t.strategie -ne 'volledig') {
          $laatst = $ts['laatst_sleutelscan']
          $nodig = $true
          if ($laatst) { $nodig = ((Get-Date).ToUniversalTime() - [datetime]::Parse($laatst).ToUniversalTime()).TotalHours -ge $scanUren }
          if ($nodig) { Sleutelscan $c $t $key }
        }
        if ($n -gt 0) { Log "  $key $($t.tbl): $n rij(en)"; $tellers["$key/$($t.tbl)"] = $n }
      } catch {
        $adminOk = $false
        Log "  $key $($t.tbl) mislukt: $($_.Exception.Message)" 'ERROR'
        [void]$fouten.Add("$key/$($t.tbl): $($_.Exception.Message)")
      }
    }
  } finally { $c.Close() }
  if ($adminOk) { [void]$klaar.Add($key) }
}

$duur = [int]((Get-Date) - $gestart).TotalSeconds
[void](Stuur '/agent/einde' @{ run_id = $runId; ok = ($fouten.Count -eq 0); detail = @{ admins = $klaar.ToArray(); fouten = $fouten.ToArray(); rijen = $tellers; seconden = $duur } })
Log "Klaar in $duur s; $($fouten.Count) fout(en)"
if ($fouten.Count -gt 0) { exit 2 }

} catch {
  Log "Run afgebroken: $($_.Exception.Message)" 'ERROR'
  exit 1
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
