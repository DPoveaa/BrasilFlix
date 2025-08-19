@echo off
echo ========================================
echo    PoFlix Bot - Iniciando...
echo ========================================
echo.

REM Verificar se node_modules existe
if not exist "node_modules" (
    echo Instalando dependencias...
    npm install
    echo.
)

REM Criar pasta data se não existir
if not exist "data" (
    echo Criando pasta data...
    mkdir data
    echo.
)

echo Iniciando o bot...
echo Pressione Ctrl+C para parar
echo.

npm start

pause 