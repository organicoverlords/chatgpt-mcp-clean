@echo off
set "_busy_cmd=%~1"
if /I "%_busy_cmd%"=="--store" set "_busy_cmd=%~3"
for %%C in (list sweep snapshot recover claim heartbeat release inspect) do if /I "%_busy_cmd%"=="%%C" goto core
python "%~dp0audit_wrapper.py" --impl python %*
exit /b %ERRORLEVEL%
:core
python "%~dp0python\busy.py" %*
