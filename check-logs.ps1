# PowerShell script to check Electron app logs

$logPath = "$env:APPDATA\sales_management\app.log"

Write-Host "Checking log file at: $logPath" -ForegroundColor Cyan
Write-Host ""

if (Test-Path $logPath) {
    Write-Host "=== Last 50 lines of log ===" -ForegroundColor Yellow
    Get-Content $logPath -Tail 50
    Write-Host ""
    Write-Host "=== End of log ===" -ForegroundColor Yellow
} else {
    Write-Host "Log file not found. The app may not have run yet." -ForegroundColor Red
    Write-Host "Try running the app first, then check this script again." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
