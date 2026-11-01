@echo off
setlocal EnableExtensions
title OpenCode launcher updater
REM ============================================================
REM  Updates the OpenCode launcher from the latest Release, on any machine,
REM  anywhere. Runs the SAME logic on every Windows 10/11 box:
REM  no local paths, user folders and temp via environment only.
REM
REM  Where it looks for the file to replace, in order:
REM    1) next to this bootstrap      (%~dp0)
REM    2) on the current user Desktop (%USERPROFILE%\Desktop)
REM    3) OneDrive Desktop redirection, when it exists
REM  If the launcher is nowhere, it is written fresh to the Desktop.
REM ============================================================

REM v2.41: the only source is the LATEST GitLab RELEASE. The launcher and
REM SHA256SUMS are read at the release tag, and the launcher must match its
REM SHA-256 line. No fallback to main: an unreleased commit is never installed.
REM PowerShell exit codes: 1 network, 2 checksum, 3 no release.
set "TMPBAT=%TEMP%\opencode_infinite_latest.bat"
if exist "%TMPBAT%" del /f /q "%TMPBAT%" >nul 2>&1

echo Downloading the newest launcher (latest Release, SHA-256 checked)...
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try{ [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $r=@(Invoke-RestMethod -UseBasicParsing -Uri 'https://gitlab.com/api/v4/projects/88367491/releases?order_by=released_at&sort=desc&per_page=1' -TimeoutSec 15); if(-not $r.Count){ exit 3 }; $t=[string]$r[0].tag_name; if($t -notmatch '^v[0-9]+[.][0-9]+$'){ exit 3 }; $b='https://gitlab.com/jekooo/opencode-infinite/-/raw/'+$t+'/'; $sf=$env:TMPBAT+'.sums'; Invoke-WebRequest -UseBasicParsing -Uri ($b+'SHA256SUMS') -OutFile $sf -TimeoutSec 15; $h=$null; foreach($l in [IO.File]::ReadAllLines($sf)){ if($l -match '^([0-9a-fA-F]{64}) [ *]OpenCode Infinite[.]bat$'){ $h=$Matches[1] } }; Remove-Item -LiteralPath $sf -Force; if(-not $h){ exit 2 }; Invoke-WebRequest -UseBasicParsing -Uri ($b+'OpenCode%%20Infinite.bat') -OutFile $env:TMPBAT -TimeoutSec 60; if((Get-FileHash -Algorithm SHA256 -LiteralPath $env:TMPBAT).Hash -ne $h){ Remove-Item -LiteralPath $env:TMPBAT -Force; exit 2 }; Write-Host ('  Release ' + $t + ', SHA-256 ok.') }catch{ exit 1 }"
if errorlevel 3 goto fail_norel
if errorlevel 2 goto fail_sum
if errorlevel 1 goto fail_net
:size_gate
set "SIZEOK="
if exist "%TMPBAT%" for %%s in ("%TMPBAT%") do if %%~zs GEQ 20000 set "SIZEOK=1"
if not defined SIZEOK goto fail_net
REM Content gate: it must be the launcher file, never an error page.
findstr /b /c:"REM  OpenCode launcher" "%TMPBAT%" >nul 2>&1
if errorlevel 1 goto fail_bad

set "TARGET="
if exist "%~dp0OpenCode Infinite.bat" set "TARGET=%~dp0OpenCode Infinite.bat"
if not defined TARGET if exist "%USERPROFILE%\Desktop\OpenCode Infinite.bat" set "TARGET=%USERPROFILE%\Desktop\OpenCode Infinite.bat"
if not defined TARGET if exist "%USERPROFILE%\OneDrive\Desktop\OpenCode Infinite.bat" set "TARGET=%USERPROFILE%\OneDrive\Desktop\OpenCode Infinite.bat"
if not defined TARGET set "TARGET=%USERPROFILE%\Desktop\OpenCode Infinite.bat"

echo Newest copy is ok. Replacing:
echo   "%TARGET%"
REM The launcher cannot be replaced while one of its windows is open:
REM ping-retry up to 5 s, then the failure speaks clearly.
set "TRI=0"
:retry
copy /y "%TMPBAT%" "%TARGET%" >nul 2>&1
if not errorlevel 1 goto done
set /a TRI+=1
if %TRI% GEQ 5 goto fail_locked
echo   trying again (%TRI%/5) - close any open OpenCode window...
ping -n 2 127.0.0.1 >nul
goto retry

:done
del /f /q "%TMPBAT%" >nul 2>&1
echo.
echo   Updated. Run "%TARGET%" now - it will keep updating itself
echo   with this same repo at every start, no laps needed.
echo.
pause
exit /b 0

:fail_locked
echo.
echo   [!] Could not replace the file: an OpenCode window still has it
echo       open. Close every OpenCode window and run this again.
del /f /q "%TMPBAT%" >nul 2>&1
pause
exit /b 1

:fail_net
echo.
echo   [!] Download failed - check the connection or try again later.
del /f /q "%TMPBAT%" >nul 2>&1
pause
exit /b 1

:fail_sum
echo.
echo   [!] The download failed its SHA-256 check - discarded, nothing replaced.
del /f /q "%TMPBAT%" >nul 2>&1
pause
exit /b 1

:fail_norel
echo.
echo   [!] No release found on GitLab yet - nothing to install.
pause
exit /b 1

:fail_bad
echo.
echo   [!] The download does not look like the launcher - discarded.
del /f /q "%TMPBAT%" >nul 2>&1
pause
exit /b 1
