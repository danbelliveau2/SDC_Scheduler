@echo off
rem One-shot helper: restart the PM2-managed scheduler (must run elevated,
rem because the PM2 daemon on this box was started from an elevated session).
call "C:\Users\akamuju\AppData\Roaming\npm\pm2.cmd" restart sdc-scheduler --update-env > "%~dp0..\pm2-restart.log" 2>&1
