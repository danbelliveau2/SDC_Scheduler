@echo off
rem ============================================================================
rem  SDC Scheduler — one-time admin cleanup (2026-06-11)
rem  RIGHT-CLICK THIS FILE -> "Run as administrator"
rem
rem  Fixes three things that need an elevated token:
rem   1. Deletes the dead sdc-scheduler-repo-sync PM2 app (superseded by the
rem      in-process sync inside server.js; it just spams "dubious ownership"
rem      errors to its log every 2 minutes).
rem   2. Grants akamuju modify rights on the whole repo so SYSTEM-written
rem      files (scripts/, .update-sha, .git internals) stop being read-only
rem      to normal sessions.
rem   3. Adds the repo to git's system-wide safe.directory list so git works
rem      for every account, including SYSTEM, without per-command flags.
rem ============================================================================

net session >nul 2>&1
if errorlevel 1 (
  echo This script must be run as administrator. Right-click it and choose
  echo "Run as administrator".
  pause
  exit /b 1
)

echo [1/3] Removing dead PM2 app sdc-scheduler-repo-sync...
call "C:\Users\akamuju\AppData\Roaming\npm\pm2.cmd" delete sdc-scheduler-repo-sync
call "C:\Users\akamuju\AppData\Roaming\npm\pm2.cmd" save

echo [2/3] Granting akamuju modify rights on the repo (takes a minute)...
icacls "D:\AI Projects\Centrailized library" /grant "stevendouglas\akamuju:(OI)(CI)M" /T /C /Q

echo [3/3] Adding system-wide git safe.directory entry...
git config --system --add safe.directory "D:/AI Projects/Centrailized library"

echo.
echo Done. Current PM2 apps:
call "C:\Users\akamuju\AppData\Roaming\npm\pm2.cmd" list
pause
