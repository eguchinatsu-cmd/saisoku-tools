@echo off
chcp 65001 >nul
echo ========================================
echo   催促ツール（Chrome拡張機能）更新
echo ========================================
echo.
echo 更新中...
echo.

set "BASE=https://raw.githubusercontent.com/eguchinatsu-cmd/saisoku-tools/main"
set "D=%~dp0"

if not exist "%D%lib" mkdir "%D%lib"
if not exist "%D%tasks" mkdir "%D%tasks"
if not exist "%D%icons" mkdir "%D%icons"

echo [1/4] メインファイル...
certutil -urlcache -split -f "%BASE%/background.js" "%D%background.js" >nul 2>&1
certutil -urlcache -split -f "%BASE%/manifest.json" "%D%manifest.json" >nul 2>&1
certutil -urlcache -split -f "%BASE%/popup.html" "%D%popup.html" >nul 2>&1
certutil -urlcache -split -f "%BASE%/popup.css" "%D%popup.css" >nul 2>&1
certutil -urlcache -split -f "%BASE%/popup.js" "%D%popup.js" >nul 2>&1

echo [2/4] lib...
certutil -urlcache -split -f "%BASE%/lib/cdp.js" "%D%lib\cdp.js" >nul 2>&1
certutil -urlcache -split -f "%BASE%/lib/kintone-api.js" "%D%lib\kintone-api.js" >nul 2>&1
certutil -urlcache -split -f "%BASE%/lib/line-chat.js" "%D%lib\line-chat.js" >nul 2>&1
certutil -urlcache -split -f "%BASE%/lib/logger.js" "%D%lib\logger.js" >nul 2>&1
certutil -urlcache -split -f "%BASE%/lib/slack.js" "%D%lib\slack.js" >nul 2>&1
certutil -urlcache -split -f "%BASE%/lib/utils.js" "%D%lib\utils.js" >nul 2>&1

echo [3/4] tasks...
certutil -urlcache -split -f "%BASE%/tasks/karisatei.js" "%D%tasks\karisatei.js" >nul 2>&1
certutil -urlcache -split -f "%BASE%/tasks/honsatei.js" "%D%tasks\honsatei.js" >nul 2>&1
certutil -urlcache -split -f "%BASE%/tasks/konpokit.js" "%D%tasks\konpokit.js" >nul 2>&1

echo [4/4] icons...
certutil -urlcache -split -f "%BASE%/icons/icon16.png" "%D%icons\icon16.png" >nul 2>&1
certutil -urlcache -split -f "%BASE%/icons/icon48.png" "%D%icons\icon48.png" >nul 2>&1
certutil -urlcache -split -f "%BASE%/icons/icon128.png" "%D%icons\icon128.png" >nul 2>&1

echo.
echo ========================================
echo   更新完了！
echo   Chromeで拡張機能を再読み込みしてください
echo   chrome://extensions → 更新ボタン
echo ========================================
echo.
pause
