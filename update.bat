@echo off
chcp 65001 >nul
echo ========================================
echo   催促ツール更新スクリプト
echo ========================================
echo.

set "BASE_URL=https://raw.githubusercontent.com/eguchinatsu-cmd/saisoku-tools/main"
set "DIR=%~dp0"

echo 更新中...

curl -sL "%BASE_URL%/lib/slack-notify.js" -o "%DIR%lib\slack-notify.js"
if errorlevel 1 (echo [ERROR] lib/slack-notify.js の取得に失敗 & goto :error)

curl -sL "%BASE_URL%/karisatei-saisoku/cli.js" -o "%DIR%karisatei-saisoku\cli.js"
if errorlevel 1 (echo [ERROR] karisatei-saisoku/cli.js の取得に失敗 & goto :error)

curl -sL "%BASE_URL%/honsatei-saisoku/cli.js" -o "%DIR%honsatei-saisoku\cli.js"
if errorlevel 1 (echo [ERROR] honsatei-saisoku/cli.js の取得に失敗 & goto :error)

curl -sL "%BASE_URL%/konpokit-saisoku/cli.js" -o "%DIR%konpokit-saisoku\cli.js"
if errorlevel 1 (echo [ERROR] konpokit-saisoku/cli.js の取得に失敗 & goto :error)

echo.
echo ========================================
echo   更新完了!
echo ========================================
echo.
pause
exit /b 0

:error
echo.
echo [ERROR] 更新に失敗しました。ネット接続を確認してください。
pause
exit /b 1
