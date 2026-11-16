@echo off
rem Builds MC Dev Hub into dist\MCDevHub.exe (a single self-contained file).
rem   build.cmd              build into dist\
rem   build.cmd <folder>     build into another folder
rem Needs the .NET 8 SDK (to build) and Node.js 20+ (to run the server). If one is missing,
rem it offers to install it with winget; if you decline, the build stops.
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "OUT=%~1"
if "%OUT%"=="" set "OUT=dist"
set "FAILED="

echo.
echo  MC Dev Hub - build
echo  ==================
echo.

rem ---------- .NET 8 SDK (or newer) ----------
call :find_dotnet
if not defined HAVE_DOTNET (
  echo  [missing] .NET 8 SDK - needed to build the app.
  call :offer_install "the .NET 8 SDK" Microsoft.DotNet.SDK.8
  if defined INSTALLED (
    if exist "%ProgramFiles%\dotnet\dotnet.exe" set "PATH=%ProgramFiles%\dotnet;%PATH%"
    call :find_dotnet
  )
)
if defined HAVE_DOTNET (echo  [ok]      .NET SDK !DOTNET_VER!) else (set "FAILED=1")

rem ---------- Node.js 20 (or newer) ----------
call :find_node
if not defined HAVE_NODE (
  if defined NODE_OLD (echo  [too old] Node.js !NODE_VER! - version 20 or newer is needed to run the app.) else (echo  [missing] Node.js - needed to run the app's server.)
  call :offer_install "Node.js (LTS)" OpenJS.NodeJS.LTS
  if defined INSTALLED (
    if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
    call :find_node
  )
)
if defined HAVE_NODE (echo  [ok]      Node.js !NODE_VER!) else (set "FAILED=1")

if defined FAILED (
  echo.
  echo  BUILD FAILED: MC Dev Hub needs both the .NET 8 SDK ^(to build the app^) and Node.js 20+ ^(to run it^).
  echo  Install the missing one^(s^) and run build.cmd again:
  if not defined HAVE_DOTNET echo    winget install Microsoft.DotNet.SDK.8      or  https://dotnet.microsoft.com/download/dotnet/8.0
  if not defined HAVE_NODE   echo    winget install OpenJS.NodeJS.LTS           or  https://nodejs.org
  goto :end_fail
)

rem ---------- the exe can't be replaced while it's running ----------
if /i "%OUT%"=="dist" (
  tasklist /FI "IMAGENAME eq MCDevHub.exe" 2>nul | find /i "MCDevHub.exe" >nul && (
    echo.
    echo  BUILD FAILED: MC Dev Hub is running, so dist\MCDevHub.exe can't be replaced.
    echo  Quit it ^(its window or tray menu ^> Quit^) and run build.cmd again.
    goto :end_fail
  )
)

rem ---------- build ----------
echo.
echo  Building into %OUT%\ ... ^(the first build downloads packages and takes a minute or two^)
echo.
dotnet publish desktop\MCDevHub -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:DebugType=none -o "%OUT%" -nologo -v:minimal
if errorlevel 1 (
  echo.
  echo  BUILD FAILED: see the messages above.
  goto :end_fail
)
dotnet build-server shutdown >nul 2>&1

echo.
echo  Done: %OUT%\MCDevHub.exe
if /i "%OUT%"=="dist" (
  echo  Start it from there the first time ^(it finds the server folder next to it^); after that you can pin it or move it.
) else (
  echo  On its first start, set Paths ^> Server folder to "%CD%\server" if it doesn't find it by itself.
)
set "CODE=0"
goto :end

:end_fail
set "CODE=1"

:end
echo.
rem keep the window open when started by double-click
echo %CMDCMDLINE% | find /i "/c" >nul && pause
exit /b %CODE%


rem =====================================================================
:find_dotnet
set "HAVE_DOTNET="
set "DOTNET_VER="
where dotnet >nul 2>&1 || exit /b 0
for /f "tokens=1" %%v in ('dotnet --list-sdks 2^>nul') do (
  for /f "tokens=1 delims=." %%m in ("%%v") do (
    if %%m GEQ 8 (set "HAVE_DOTNET=1" & set "DOTNET_VER=%%v")
  )
)
exit /b 0

:find_node
set "HAVE_NODE="
set "NODE_OLD="
set "NODE_VER="
where node >nul 2>&1 || exit /b 0
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
if not defined NODE_VER exit /b 0
set "NODE_MAJOR=!NODE_VER:v=!"
for /f "tokens=1 delims=." %%m in ("!NODE_MAJOR!") do set "NODE_MAJOR=%%m"
if !NODE_MAJOR! GEQ 20 (set "HAVE_NODE=1") else (set "NODE_OLD=1")
exit /b 0

rem :offer_install "<display name>" <winget id>  ->  sets INSTALLED when the install worked
:offer_install
set "INSTALLED="
set "ANSWER="
set /p "ANSWER=  ? Install %~1 now with winget? [Y/N] "
if /i not "!ANSWER!"=="Y" if /i not "!ANSWER!"=="YES" (echo            Skipped.& exit /b 0)
where winget >nul 2>&1 || (echo            winget isn't available on this PC, so it can't be installed from here.& exit /b 0)
echo.
winget install --id %~2 -e
if errorlevel 1 (echo            The install didn't finish.& exit /b 0)
set "INSTALLED=1"
echo.
exit /b 0
