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

set OK=0
set NG=0

echo [1/4] メインファイル...
call :dl "background.js" ""
call :dl "manifest.json" ""
call :dl "popup.html" ""
call :dl "popup.css" ""
call :dl "popup.js" ""

echo [2/4] lib...
call :dl "cdp.js" "lib\"
call :dl "kintone-api.js" "lib\"
call :dl "line-chat.js" "lib\"
call :dl "logger.js" "lib\"
call :dl "slack.js" "lib\"
call :dl "utils.js" "lib\"

echo [3/4] tasks...
call :dl "karisatei.js" "tasks\"
call :dl "honsatei.js" "tasks\"
call :dl "konpokit.js" "tasks\"

echo [4/4] icons...
call :dl "icon16.png" "icons\"
call :dl "icon48.png" "icons\"
call :dl "icon128.png" "icons\"

echo.
if %NG% GTR 0 (
  echo [ERROR] %NG% 件失敗しました。ネット接続を確認してください。
) else (
  echo ========================================
  echo   更新完了！ %OK% ファイル
  echo   Chromeで拡張機能を再読み込みしてください
  echo   chrome://extensions → 更新ボタン
  echo ========================================
)
echo.
pause
exit /b 0

:dl
set "FILE=%~1"
set "SUB=%~2"
powershell -Command "Invoke-WebRequest -Uri '%BASE%/%SUB%%FILE%' -OutFile '%D%%SUB%%FILE%' -UseBasicParsing" 2>nul
if errorlevel 1 (
  echo   [ERROR] %SUB%%FILE%
  set /a NG+=1
) else (
  set /a OK+=1
)
exit /b
