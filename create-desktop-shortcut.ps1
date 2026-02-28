
$appPath = Join-Path $PSScriptRoot "dist\win-unpacked\D&M Sales Management.exe"
$iconPath = Join-Path $PSScriptRoot "build\icons\icon.png"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "D&M Sales Management.lnk"


if (-not (Test-Path $appPath)) {
    Write-Host "Error: Executable not found at $appPath" -ForegroundColor Red
    Write-Host "Please run 'npm run build:win' first to create the executable." -ForegroundColor Yellow
    exit 1
}


$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = $appPath
$Shortcut.WorkingDirectory = Split-Path $appPath
$Shortcut.Description = "D&M Sales Management - Desktop Application"
$Shortcut.IconLocation = $appPath  # Use the executable's icon (electron-builder embeds it)


$Shortcut.Save()

Write-Host "Desktop shortcut created successfully!" -ForegroundColor Green
Write-Host "Location: $shortcutPath" -ForegroundColor Cyan
