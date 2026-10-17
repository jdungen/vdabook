<#
.SYNOPSIS
  Installeert de VDA Book Globe-sync-agent op de pc met Exact Globe+.

.DESCRIPTION
  Eenmalig uitvoeren als beheerder, in deze map (naast GlobeSync.ps1):

    powershell -ExecutionPolicy Bypass -File .\Installeer.ps1

  Wat er gebeurt:
   1. GlobeSync.ps1 en een config komen in C:\ProgramData\VDA-GlobeSync,
      alleen leesbaar voor SYSTEM en beheerders. De agent-token staat er
      versleuteld in (DPAPI, gebonden aan deze pc).
   2. Het systeemaccount krijgt per Globe-database alleen db_datareader.
      Lezen, niets anders.
   3. Een geplande taak draait de agent bij opstarten en daarna elk half uur.
   4. De eerste sync start meteen.

  Verwijderen:  .\Installeer.ps1 -Verwijder
#>
[CmdletBinding()]
param(
  [string]$Endpoint = 'https://vdabook-production.up.railway.app',
  [string]$Token,
  [switch]$Verwijder,
  [switch]$GeenEersteRun
)

$ErrorActionPreference = 'Stop'
$Doel = Join-Path $env:ProgramData 'VDA-GlobeSync'
$TaakNaam = 'VDA Book - Globe sync'
$Login = 'NT AUTHORITY\SYSTEM'

function Stap([string]$t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok([string]$t) { Write-Host "   $t" -ForegroundColor Green }
function Let([string]$t) { Write-Host "   $t" -ForegroundColor Yellow }

$beheerder = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $beheerder) { throw 'Start PowerShell als administrator (rechtermuisklik > Als administrator uitvoeren).' }

# ------------------------------------------------------------- verwijderen

if ($Verwijder) {
  Stap 'Geplande taak weghalen'
  Unregister-ScheduledTask -TaskName $TaakNaam -Confirm:$false -ErrorAction SilentlyContinue
  Ok 'weg'
  Stap "Map $Doel weghalen"
  Remove-Item $Doel -Recurse -Force -ErrorAction SilentlyContinue
  Ok 'weg'
  Let 'De leesrechten van het systeemaccount in SQL Server blijven staan. Intrekken (per database):'
  Let "  ALTER ROLE db_datareader DROP MEMBER [$Login];"
  return
}

$Bron = Join-Path $PSScriptRoot 'GlobeSync.ps1'
if (-not (Test-Path $Bron)) { throw "GlobeSync.ps1 niet gevonden naast dit script ($PSScriptRoot)." }

# ------------------------------------------------------------------ token

if (-not $Token) {
  Write-Host 'Plak de agent-token (Railway > vdabook > Variables > AGENT_TOKEN). Hij wordt niet getoond.'
  $sec = Read-Host -AsSecureString 'Agent-token'
  $Token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
$Token = $Token.Trim()
if ($Token.Length -lt 32) { throw 'Die token is te kort; kopieer hem volledig uit Railway.' }

Stap 'Verbinding met de spiegel testen'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "$Endpoint/agent/status" -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 30
  Ok "bereikbaar, token geaccepteerd ($($r.StatusCode))"
} catch {
  $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  if ($code -eq 401) { throw 'De server weigert deze token (401). Controleer AGENT_TOKEN in Railway.' }
  throw "Server niet bereikbaar: $($_.Exception.Message). Staat er een proxy of firewall tussen?"
}

# -------------------------------------------------------- bestanden + ACL

Stap "Agent installeren in $Doel"
New-Item -ItemType Directory -Path $Doel -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Doel 'logs') -Force | Out-Null

# Alleen SYSTEM en beheerders: gewone gebruikers kunnen het script niet
# aanpassen (het draait als SYSTEM) en de config niet lezen.
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($wie in @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators')) {
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($wie, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
}
Set-Acl -Path $Doel -AclObject $acl
Copy-Item $Bron (Join-Path $Doel 'GlobeSync.ps1') -Force
Ok 'GlobeSync.ps1 geplaatst, map afgeschermd'

Add-Type -AssemblyName System.Security
$versleuteld = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($Token), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
$config = [ordered]@{
  endpoint    = $Endpoint.TrimEnd('/')
  token_dpapi = [Convert]::ToBase64String($versleuteld)
  blok_rijen  = 2000
}
$config | ConvertTo-Json | Set-Content -Path (Join-Path $Doel 'config.json') -Encoding UTF8
Ok 'config.json geschreven (token versleuteld met DPAPI, alleen bruikbaar op deze pc)'

# ------------------------------------------------------------- SQL-rechten

Stap 'Leesrechten in SQL Server'

function Instances {
  $lijst = @()
  $reg = 'HKLM:\SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL'
  if (Test-Path $reg) {
    foreach ($n in (Get-Item $reg).Property) { if ($n -eq 'MSSQLSERVER') { $lijst += '.' } else { $lijst += ".\$n" } }
  }
  return $lijst
}

function Verbind([string]$server, [pscredential]$cred) {
  if ($cred) {
    $cs = "Server=$server;Database=master;User ID=$($cred.UserName);Password=$($cred.GetNetworkCredential().Password);Encrypt=False;TrustServerCertificate=True;Connect Timeout=15"
  } else {
    $cs = "Server=$server;Database=master;Integrated Security=SSPI;Encrypt=False;TrustServerCertificate=True;Connect Timeout=15"
  }
  $c = New-Object System.Data.SqlClient.SqlConnection($cs); $c.Open(); return $c
}

function Uitvoeren($c, [string]$sql) {
  $cmd = $c.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 120
  return $cmd.ExecuteScalar()
}

$grant = @"
IF SUSER_ID(N'$Login') IS NULL CREATE LOGIN [$Login] FROM WINDOWS;
"@
$perDb = @"
IF OBJECT_ID('dbo.gbkmut') IS NOT NULL AND OBJECT_ID('dbo.grtbk') IS NOT NULL
BEGIN
  IF DATABASE_PRINCIPAL_ID(N'$Login') IS NULL CREATE USER [$Login] FOR LOGIN [$Login];
  EXEC sp_addrolemember N'db_datareader', N'$Login';
  SELECT 1;
END
ELSE SELECT 0;
"@

$gevonden = 0
$instances = @(Instances)
if ($instances.Count -eq 0) { Let 'Geen SQL Server-instances in het register gevonden.' }
foreach ($inst in $instances) {
  $cred = $null
  try { $c = Verbind $inst $null } catch {
    Let "Windows-aanmelding op $inst mislukt: $($_.Exception.Message)"
    $cred = Get-Credential -Message "SQL-beheerder voor $inst (bijv. sa) - alleen gebruikt om leesrechten te geven, niet bewaard"
    $c = Verbind $inst $cred
  }
  try {
    [void](Uitvoeren $c $grant)
    $cmd = $c.CreateCommand(); $cmd.CommandText = 'SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 ORDER BY name'
    $rd = $cmd.ExecuteReader(); $dbs = @(); while ($rd.Read()) { $dbs += $rd.GetString(0) }; $rd.Close()
    foreach ($db in $dbs) {
      try {
        $c.ChangeDatabase($db)
        if ([int](Uitvoeren $c $perDb) -eq 1) { Ok "$inst / $db : db_datareader voor $Login"; $gevonden++ }
      } catch { Let "$inst / $db overgeslagen: $($_.Exception.Message)" }
    }
  } catch {
    Let "Rechten zetten op $inst mislukt: $($_.Exception.Message)"
    Let 'Laat een SQL-beheerder per Globe-database uitvoeren:'
    Let "  CREATE USER [$Login] FOR LOGIN [$Login]; ALTER ROLE db_datareader ADD MEMBER [$Login];"
  } finally { $c.Close() }
}
if ($gevonden -eq 0) { Let 'Geen Globe-databases met leesrechten. De agent wordt wel ingepland, maar vindt niets tot de rechten er zijn.' }

# --------------------------------------------------------------- planning

Stap 'Geplande taak'
$actie = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Doel\GlobeSync.ps1`""
$bijStart = New-ScheduledTaskTrigger -AtStartup
$bijStart.Delay = 'PT2M'
$elkHalfUur = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 30)
$wie = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$instellingen = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $TaakNaam -Action $actie -Trigger @($bijStart, $elkHalfUur) -Principal $wie -Settings $instellingen `
  -Description 'VDA Book: spiegelt de Exact Globe+-administraties read-only naar de spiegel op Railway. Bij opstarten en elk half uur.' -Force | Out-Null
Ok "'$TaakNaam': bij opstarten (+2 min) en elk half uur, als SYSTEM"

if (-not $GeenEersteRun) {
  Stap 'Eerste sync starten'
  Start-ScheduledTask -TaskName $TaakNaam
  Ok 'gestart op de achtergrond. De eerste keer haalt hij alles op; dat kan even duren.'
  Ok "Logboek: $Doel\logs (alleen als beheerder te openen)"
}

Write-Host "`nKlaar." -ForegroundColor Green
