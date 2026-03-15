@echo off
:: BOB CLI — Build On BNB (Windows)
:: Usage: bob quick | swarm | scout | push | oracle | database | deploy | status

if "%1"=="" goto menu
if "%1"=="quick" goto quick
if "%1"=="swarm" goto swarm
if "%1"=="scout" goto scout
if "%1"=="scout:ext" goto scout_ext
if "%1"=="push" goto push
if "%1"=="greet" goto greet
if "%1"=="database" goto database
if "%1"=="oracle" goto oracle
if "%1"=="deploy" goto deploy
if "%1"=="snapshot" goto snapshot
if "%1"=="update" goto update
if "%1"=="improve" goto improve
if "%1"=="mint-brain" goto mint_brain
if "%1"=="status" goto status
if "%1"=="logs" goto logs
if "%1"=="start" goto start
goto menu

:quick
echo.
echo   +=====================================================+
echo   ^|   BOB QUICK — Daily Agent Run                       ^|
echo   ^|   Push + Scout:Ext + Database + Oracle + Deploy      ^|
echo   +=====================================================+
echo.
echo   [1/4] PUSHER — Checking new agents + contacting A2A...
echo   -----------------------------------------------------
start "BOB ORACLE" cmd /c "cd /d %~dp0 && npx tsx src/oracle.ts && pause"
call npx tsx src/pusher.ts
echo.
echo   [2/4] SCOUT:EXT — External Re-Check...
echo   -----------------------------------------------------
call npx tsx src/scout-external.ts
echo.
echo   [3/4] DATABASE — Analyzing + Sorting...
echo   -----------------------------------------------------
call npx tsx src/database.ts
echo.
echo   [4/4] DEPLOY — Snapshot + Vercel...
echo   -----------------------------------------------------
call npx tsx src/build-snapshot.ts && call npx vercel --prod --yes
echo.
echo   +=====================================================+
echo   ^|   QUICK COMPLETE — Oracle ran parallel               ^|
echo   ^|   BSC + External checked, sorted, deployed           ^|
echo   +=====================================================+
echo.
goto end

:swarm
echo.
echo   +=====================================================+
echo   ^|   BOB SWARM — Full Scan (alle 3 Tage)               ^|
echo   ^|   Scout + Scout:Ext + Database + Push + Oracle       ^|
echo   +=====================================================+
echo.
echo   [1/6] SCOUT — Full BSC Registry Scan (~40 Min)...
echo   -----------------------------------------------------
start "BOB ORACLE" cmd /c "cd /d %~dp0 && npx tsx src/oracle.ts && pause"
call npx tsx src/scout-fast.ts
echo.
echo   [2/6] SCOUT:EXT — External A2A Discovery...
echo   -----------------------------------------------------
call npx tsx src/scout-external.ts
echo.
echo   [3/6] DATABASE — Analyzing + Sorting...
echo   -----------------------------------------------------
call npx tsx src/database.ts
echo.
echo   [4/6] PUSHER — Contacting A2A Agents...
echo   -----------------------------------------------------
call npx tsx src/pusher.ts
echo.
echo   [5/6] DEPLOY — Snapshot + Vercel...
echo   -----------------------------------------------------
call npx tsx src/build-snapshot.ts && call npx vercel --prod --yes
echo.
echo   +=====================================================+
echo   ^|   SWARM COMPLETE — All agents finished               ^|
echo   ^|   BSC + External scanned, sorted, pushed, deployed   ^|
echo   +=====================================================+
echo.
goto end

:scout
call npx tsx src/scout-fast.ts %2 %3 %4
goto end

:scout_ext
echo.
echo   SCOUT:EXT — External A2A Agent Discovery
echo   -----------------------------------------
call npx tsx src/scout-external.ts
goto end

:push
call npx tsx src/pusher.ts %2 %3 %4
goto end

:greet
call npx tsx src/pusher.ts -- --greet
goto end

:database
call npx tsx src/database.ts
goto end

:oracle
call npx tsx src/oracle.ts
goto end

:deploy
call npx tsx src/build-snapshot.ts && call npx vercel --prod --yes
goto end

:snapshot
call npx tsx src/build-snapshot.ts
goto end

:update
call npx tsx src/update-agents.ts
goto end

:improve
echo.
echo   BOB SELF-IMPROVE — Code Self-Modification Engine
echo   Analyze errors, generate fixes, test, apply or revert
echo.
call npx tsx src/self-improve.ts
goto end

:mint_brain
echo.
echo   BOB MINT-BRAIN — Register BRAIN as 5th Agent on BSC
echo   This costs Gas (BNB)!
echo.
call npx tsx src/update-agents.ts --mint-brain
goto end

:status
curl -s https://project-gkws4.vercel.app/health | npx tsx -e "process.stdin.on('data',d=>{const h=JSON.parse(d);console.log('  BOB '+h.version+' - '+h.status)})"
goto end

:logs
call npx vercel logs https://project-gkws4.vercel.app --follow
goto end

:start
echo.
echo   BOB START — Autonomous Agent Intelligence
echo   SCOUT . DATABASE . PUSHER . ORACLE
echo   Press Ctrl+C to stop gracefully
echo.
call npx tsx src/bob-start.ts %2 %3
goto end

:menu
echo.
echo   +===============================================================+
echo   ^|   BOB — Build On BNB ^| Agent Intelligence Service             ^|
echo   +===============================================================+
echo   ^|                                                                ^|
echo   ^|   DAILY (schnell, 2-3 Min)                                    ^|
echo   ^|   ----------------------------------------------------------  ^|
echo   ^|   bob quick     Push + Database + Oracle + Deploy              ^|
echo   ^|                 Oracle laeuft parallel                         ^|
echo   ^|                                                                ^|
echo   ^|   FULL SCAN (alle 3 Tage, ~45 Min)                            ^|
echo   ^|   ----------------------------------------------------------  ^|
echo   ^|   bob swarm     Scout + Database + Push + Oracle + Deploy      ^|
echo   ^|                 Scannt ALLE IDs auf BSC                        ^|
echo   ^|                                                                ^|
echo   ^|   EINZELN                                                      ^|
echo   ^|   ----------------------------------------------------------  ^|
echo   ^|   bob scout     BSC Registry scannen (alle IDs)                ^|
echo   ^|   bob scout:ext External A2A Agents scannen (NEU)              ^|
echo   ^|   bob push      Nur neue IDs seit letztem Scan                 ^|
echo   ^|   bob database  Daten sortieren + klassifizieren               ^|
echo   ^|   bob oracle    Health Check + Treasury + Network              ^|
echo   ^|   bob deploy    Snapshot bauen + Vercel deployen               ^|
echo   ^|   bob update    On-chain Metadata updaten (kostet Gas!)        ^|
echo   ^|   bob improve   Self-Improve: BOB aendert seinen eigenen Code ^|
echo   ^|   bob mint-brain BRAIN als 5. Agent registrieren (Gas!)       ^|
echo   ^|   bob status    Lebt BOB?                                      ^|
echo   ^|   bob logs      Live Vercel Logs                               ^|
echo   ^|                                                                ^|
echo   ^|   AUTONOMOUS                                                   ^|
echo   ^|   ----------------------------------------------------------  ^|
echo   ^|   bob start     Startet alle Agents autonom (laeuft dauerhaft) ^|
echo   ^|                 SCOUT, DATABASE, PUSHER, ORACLE, BRAIN         ^|
echo   ^|                 + Self-Improve + Chain/API Discovery           ^|
echo   ^|                 + Auto-Deploy + Auto-Update (on-chain)         ^|
echo   ^|                                                                ^|
echo   +===============================================================+
echo.

:end
