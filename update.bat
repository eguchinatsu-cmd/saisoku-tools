@echo off
chcp 65001 >nul
echo ========================================
echo   催促ツール（Chrome拡張機能）更新
echo ========================================
echo.

set "BASE_URL=https://raw.githubusercontent.com/eguchinatsu-cmd/saisoku-tools/main"
set "DIR=%~dp0"

echo 更新中...
echo.

:: メインファイル
echo [1/4] メインファイル...
curl -sL "%BASE_URL%/background.js" -o "%DIR%background.js"
if errorlevel 1 (echo [ERROR] background.js & goto :error)
curl -sL "%BASE_URL%/manifest.json" -o "%DIR%manifest.json"
if errorlevel 1 (echo [ERROR] manifest.json & goto :error)
curl -sL "%BASE_URL%/popup.html" -o "%DIR%popup.html"
if errorlevel 1 (echo [ERROR] popup.html & goto :error)
curl -sL "%BASE_URL%/popup.css" -o "%DIR%popup.css"
if errorlevel 1 (echo [ERROR] popup.css & goto :error)
curl -sL "%BASE_URL%/popup.js" -o "%DIR%popup.js"
if errorlevel 1 (echo [ERROR] popup.js & goto :error)

:: lib
echo [2/4] lib...
if not exist "%DIR%lib" mkdir "%DIR%lib"
curl -sL "%BASE_URL%/lib/cdp.js" -o "%DIR%lib\cdp.js"
if errorlevel 1 (echo [ERROR] lib/cdp.js & goto :error)
curl -sL "%BASE_URL%/lib/kintone-api.js" -o "%DIR%lib\kintone-api.js"
if errorlevel 1 (echo [ERROR] lib/kintone-api.js & goto :error)
curl -sL "%BASE_URL%/lib/line-chat.js" -o "%DIR%lib\line-chat.js"
if errorlevel 1 (echo [ERROR] lib/line-chat.js & goto :error)
curl -sL "%BASE_URL%/lib/logger.js" -o "%DIR%lib\logger.js"
if errorlevel 1 (echo [ERROR] lib/logger.js & goto :error)
curl -sL "%BASE_URL%/lib/slack.js" -o "%DIR%lib\slack.js"
if errorlevel 1 (echo [ERROR] lib/slack.js & goto :error)
curl -sL "%BASE_URL%/lib/utils.js" -o "%DIR%lib\utils.js"
if errorlevel 1 (echo [ERROR] lib/utils.js & goto :error)

:: tasks
echo [3/4] tasks...
if not exist "%DIR%tasks" mkdir "%DIR%tasks"
curl -sL "%BASE_URL%/tasks/karisatei.js" -o "%DIR%tasks\karisatei.js"
if errorlevel 1 (echo [ERROR] tasks/karisatei.js & goto :error)
curl -sL "%BASE_URL%/tasks/honsatei.js" -o "%DIR%tasks\honsatei.js"
if errorlevel 1 (echo [ERROR] tasks/honsatei.js & goto :error)
curl -sL "%BASE_URL%/tasks/konpokit.js" -o "%DIR%tasks\konpokit.js"
if errorlevel 1 (echo [ERROR] tasks/konpokit.js & goto :error)

:: icons
echo [4/4] icons...
if not exist "%DIR%icons" mkdir "%DIR%icons"
curl -sL "%BASE_URL%/icons/icon16.png" -o "%DIR%icons\icon16.png"
if errorlevel 1 (echo [ERROR] icons/icon16.png & goto :error)
curl -sL "%BASE_URL%/icons/icon48.png" -o "%DIR%icons\icon48.png"
if errorlevel 1 (echo [ERROR] icons/icon48.png & goto :error)
curl -sL "%BASE_URL%/icons/icon128.png" -o "%DIR%icons\icon128.png"
if errorlevel 1 (echo [ERROR] icons/icon128.png & goto :error)

echo.
echo ========================================
echo   更新完了！
echo   Chromeで拡張機能を再読み込みしてください
echo   chrome://extensions → 更新ボタン
echo ========================================
echo.
pause
exit /b 0

:error
echo.
echo [ERROR] 更新に失敗しました。ネット接続を確認してください。
pause
exit /b 1
