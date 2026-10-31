@echo off
setlocal
pushd "%~dp0"
echo ========================================================
echo Starting BlueCode OS PayU MERN Application
echo ========================================================

if not exist "BlueCodeOS-PayU-MERN\server\node_modules" (
  echo Installing backend dependencies...
  call npm --prefix "BlueCodeOS-PayU-MERN\server" install
  if errorlevel 1 goto :error
)
if not exist "BlueCodeOS-PayU-MERN\client\node_modules" (
  echo Installing frontend dependencies...
  call npm --prefix "BlueCodeOS-PayU-MERN\client" install
  if errorlevel 1 goto :error
)

start "BlueCode OS - Backend API (:5000)" cmd /k "cd /d ""%~dp0BlueCodeOS-PayU-MERN\server"" && npm run dev"
timeout /t 2 /nobreak >nul
start "BlueCode OS - Frontend (:5173)" cmd /k "cd /d ""%~dp0BlueCodeOS-PayU-MERN\client"" && npm run dev"

echo.
echo Both Frontend (http://localhost:5173) and Backend (http://localhost:5000) are starting up!
echo Press any key to exit this launcher window...
pause >nul
popd
exit /b 0

:error
echo Dependency installation failed. Check that Node.js/npm and internet access are available.
pause
popd
exit /b 1
