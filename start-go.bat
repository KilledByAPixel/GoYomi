@echo off
rem Starts the Go Dojo server and opens it in the default browser.
cd /d "%~dp0"
start "" http://localhost:8115
node serve.js 8115
