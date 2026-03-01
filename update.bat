@echo off
echo ========================================
echo   Saisoku Tools Updater
echo ========================================
echo.

set "BASE_URL=https://raw.githubusercontent.com/eguchinatsu-cmd/saisoku-tools/main"
set "DIR=%~dp0"

echo Updating...

curl -sL "%BASE_URL%/lib/slack-notify.js" -o "%DIR%lib\slack-notify.js"
if errorlevel 1 (echo [ERROR] lib/slack-notify.js failed & goto :error)

curl -sL "%BASE_URL%/karisatei-saisoku/cli.js" -o "%DIR%karisatei-saisoku\cli.js"
if errorlevel 1 (echo [ERROR] karisatei-saisoku/cli.js failed & goto :error)

curl -sL "%BASE_URL%/honsatei-saisoku/cli.js" -o "%DIR%honsatei-saisoku\cli.js"
if errorlevel 1 (echo [ERROR] honsatei-saisoku/cli.js failed & goto :error)

curl -sL "%BASE_URL%/konpokit-saisoku/cli.js" -o "%DIR%konpokit-saisoku\cli.js"
if errorlevel 1 (echo [ERROR] konpokit-saisoku/cli.js failed & goto :error)

echo.
echo ========================================
echo   Update complete!
echo ========================================
echo.
pause
exit /b 0

:error
echo.
echo [ERROR] Update failed. Check internet connection.
pause
exit /b 1
