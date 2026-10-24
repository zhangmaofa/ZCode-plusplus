@echo off
rem ZCode++ auto-installer: waits for ZCode to close, installs, restarts ZCode.
rem Double-click this file or launch it detached; see install-run.log for output.
cd /d "%~dp0"
echo %date% %time% waiting for ZCode to close, then installing ZCode++ ...> install-run.log
node bin\zcodepp.js install --wait --start >> install-run.log 2>&1
echo %date% %time% installer exited with code %ERRORLEVEL%>> install-run.log
