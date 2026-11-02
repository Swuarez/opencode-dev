// Generated from the launcher's VPN Gate helper (OC_VGHELP block). Keep the two in sync.
// The helper runs elevated once per session; it is sent as -EncodedCommand, never written to disk.
#pragma once
namespace oi {
inline std::string vgHelperScript() {
    return std::string()
        + R"PS(
# VPN Gate helper (v2.54). Runs elevated ONCE per session (one UAC prompt), then serves the requests
# of the launcher user only: the named pipe accepts that user's SID alone. It never takes an exe or a
# folder from a request. Every config is checked against an allow-list and written to an
# administrator-only folder before OpenVPN reads it, so the user cannot change it in between.
# Input (set by the launcher above this text): $Pipe, $ClientSid, $IdleSec, and in tests only $OvpnExe.
$ErrorActionPreference = 'Stop'
$Test = [bool]$env:OC_VG_RUNDIR
$Dir = $(if ($Test) { $env:OC_VG_RUNDIR } else { Join-Path $env:ProgramData 'opencode-infinite\vgate-run' })
$Allowed = @('client', 'dev', 'dev-type', 'proto', 'remote', 'remote-random', 'nobind', 'persist-key', 'persist-tun', 'resolv-retry', 'cipher', 'data-ciphers', 'data-ciphers-fallback', 'auth', 'auth-nocache', 'comp-lzo', 'compress', 'verb', 'remote-cert-tls', 'key-direction', 'tls-client', 'tls-cipher', 'tls-version-min', 'verify-x509-name', 'ping', 'ping-restart', 'ping-exit', 'connect-retry', 'connect-retry-max', 'connect-timeout', 'keepalive', 'mssfix', 'tun-mtu', 'link-mtu', 'float', 'reneg-sec', 'explicit-exit-notify', 'allow-recursive-routing', 'ignore-unknown-option', 'route', 'route-nopull', 'route-ipv6', 'route-method', 'route-delay', 'pull-filter', 'ifconfig-ipv6', 'block-ipv6', 'fragment', 'sndbuf', 'rcvbuf', 'tcp-nodelay', 'tls-timeout')
$Blocks = @('ca', 'cert', 'key', 'tls-auth', 'tls-crypt')
function Harden([string]$d) {
  if ($Test) { return }
  $own = (Get-Acl -LiteralPath $d).GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($own -ne 'S-1-5-32-544' -and $own -ne 'S-1-5-18') { throw 'the run folder is not owned by administrators' }
  & icacls.exe $d /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
}
$Parent = Split-Path -Parent $Dir
foreach ($d in @($Parent, $Dir)) { if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d | Out-Null }; Harden $d }
# '' when every directive is allowed, else the first one that is not
function Cfg-Error([string]$t) {
  $blk = ''
  foreach ($ln in ($t -split "`r?`n")) {
    $s = $ln.Trim()
    if ($blk) { if ($s -eq ('</' + $blk + '>')) { $blk = '' }; continue }
    if ($s -match '^<([A-Za-z-]+)>$') { if ($Blocks -notcontains $matches[1]) { return ('block ' + $matches[1]) }; $blk = $matches[1]; continue }
    if ($s -eq '' -or $s[0] -eq '#' -or $s[0] -eq ';') { continue }
    $k = ($s -split '\s+')[0]
    if ($Allowed -notcontains $k) { return ('directive ' + $k) }
  }
  if ($blk) { return 'unclosed block' }
  return ''
}
function Drop-Routes {
  $f = Join-Path $Dir 'routes.txt'
  if (-not (Test-Path -LiteralPath $f)) { return }
  foreach ($ip in @(Get-Content -LiteralPath $f)) {
    if ($ip) { Get-NetRoute -DestinationPrefix ($ip + $(if ($ip -like '*:*') { '/128' } else { '/32' })) -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceAlias -like 'OpenVPN*' } | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue
}
$script:Tun = $null
function Tun-Up { return ($null -ne $script:Tun -and -not $script:Tun.HasExited) }
function Stop-Tun {
  if ($script:Tun) { try { if (-not $script:Tun.HasExited) { Stop-Process -Id $script:Tun.Id -Force } } catch { }; $script:Tun = $null }
  Drop-Routes
}
function Find-Ovpn {
  if ($Test) { return $OvpnExe }
  foreach ($c in @((Join-Path $env:ProgramFiles 'OpenVPN\bin\openvpn.exe'), (Join-Path ${env:ProgramFiles(x86)} 'OpenVPN\bin\openvpn.exe'))) { if (Test-Path -LiteralPath $c) { return $c } }
  return ''
}
# shared read: OpenVPN keeps its log open while it runs
function Read-Shared([string]$p) {
  $fs = [IO.File]::Open($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]'ReadWrite,Delete'))
  try { $sr = New-Object IO.StreamReader($fs); return $sr.ReadToEnd() } finally { $fs.Dispose() }
}
function Start-Vpn([string]$ipsText, [string]$cfgText, [int]$secs) {
  Stop-Tun
  $ovpn = Find-Ovpn
  if (-not $ovpn) { return 'FAIL openvpn is missing' }
  $err = Cfg-Error $cfgText
  if ($err) { return ('FAIL config rejected: ' + $err) }
  $ips = @($ipsText -split ' ' | Where-Object { $_ })
  if ($ips.Count -eq 0) { return 'FAIL no ip' }
  foreach ($ip in $ips) { $a = $null; if (-not [Net.IPAddress]::TryParse($ip, [ref]$a)) { return 'FAIL bad ip' } }
  $cfg = Join-Path $Dir 'run.ovpn'
  $log = Join-Path $Dir 'openvpn.log'
  Remove-Item -LiteralPath $log -Force -ErrorAction SilentlyContinue
  [IO.File]::WriteAllText($cfg, $cfgText, (New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllText((Join-Path $Dir 'routes.txt'), ($ips -join "`r`n"))
  $p = Start-Process -FilePath $ovpn -ArgumentList @('--config', ('"' + $cfg + '"'), '--log', ('"' + $log + '"'), '--verb', '3', '--connect-retry-max', '2', '--auth-nocache') -WindowStyle Hidden -PassThru
  $script:Tun = $p
  $end = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $end) {
    if (Test-Path -LiteralPath $log) {
      $t = Read-Shared $log
      if ($t -match 'Initialization Sequence Completed') { return 'OK' }
      if ($t -match 'AUTH_FAILED|Exiting due to fatal error|SIGTERM') { break }
    }
    if ($p.HasExited) { break }
    Start-Sleep -Milliseconds 500
  }
  Stop-Tun
  return 'FAIL tunnel did not start'
}
function Handle([string]$req) {
  $p = @($req -split ' ', 5)
  switch ($p[0]) {
    'STATUS' { if (Tun-Up) { return 'UP' } else { return 'DOWN' } }
    'STOP' { Stop-Tun; return 'OK' }
    'QUIT' { Stop-Tun; return 'OK' }
    'START' {
      if ($p.Count -lt 4) { return 'FAIL bad request' }
      $secs = 0; if (-not [int]::TryParse($p[3], [ref]$secs) -or $secs -lt 5 -or $secs -gt 300) { return 'FAIL bad timeout' }
      $ipsText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))
      $cfgText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2]))
      return (Start-Vpn $ipsText $cfgText $secs)
    }
    default { return 'FAIL unknown request' }
)PS"
        + R"PS(
  }
}
$sec = New-Object IO.Pipes.PipeSecurity
$sec.AddAccessRule((New-Object IO.Pipes.PipeAccessRule((New-Object Security.Principal.SecurityIdentifier($ClientSid)), [IO.Pipes.PipeAccessRights]::ReadWrite, [Security.AccessControl.AccessControlType]::Allow)))
$lastUse = Get-Date
while ($true) {
  $srv = New-Object IO.Pipes.NamedPipeServerStream -ArgumentList @($Pipe, [IO.Pipes.PipeDirection]::InOut, 1, [IO.Pipes.PipeTransmissionMode]::Byte, [IO.Pipes.PipeOptions]::Asynchronous, 65536, 65536, $sec)
  $task = $srv.WaitForConnectionAsync()
  $idle = $false
  while (-not $task.Wait(1000)) { if (((Get-Date) - $lastUse).TotalSeconds -gt $IdleSec) { $idle = $true; break } }
  if ($idle) { $srv.Dispose(); Stop-Tun; break }
  $quit = $false
  try {
    $r = New-Object IO.StreamReader($srv, [Text.Encoding]::UTF8, $false, 65536, $true)
    $w = New-Object IO.StreamWriter($srv, (New-Object Text.UTF8Encoding $false), 65536, $true)
    $w.AutoFlush = $true; $w.NewLine = "`n"
    $req = [string]$r.ReadLine()
    $res = 'FAIL no answer'
    try { $res = [string](Handle $req) } catch { $res = 'FAIL ' + ($_.Exception.Message -replace '\s+', ' ') }
    $w.WriteLine($res)
    $quit = ($req -like 'QUIT*')
    $lastUse = Get-Date
  } catch { } finally { try { $srv.WaitForPipeDrain() } catch { }; try { $srv.Disconnect() } catch { }; $srv.Dispose() }
  if ($quit) { break }
}
)PS"
        ;
}
} // namespace oi
