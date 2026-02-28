

$unpackedPath = "dist\win-unpacked"
$asarPath = "$unpackedPath\resources\app.asar"

Write-Host "=== Electron App Size Analysis ===" -ForegroundColor Cyan
Write-Host ""

if (Test-Path $unpackedPath) {
    $totalSize = (Get-ChildItem $unpackedPath -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB
    Write-Host "Total unpacked size: $([math]::Round($totalSize, 2)) MB" -ForegroundColor Yellow
    Write-Host ""
    
    Write-Host "Top 10 largest directories:" -ForegroundColor Green
    Get-ChildItem $unpackedPath -Directory -Recurse | 
        ForEach-Object {
            $size = (Get-ChildItem $_.FullName -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
            [PSCustomObject]@{
                Path = $_.FullName.Replace((Resolve-Path $unpackedPath).Path + "\", "")
                SizeMB = [math]::Round($size, 2)
            }
        } | 
        Sort-Object SizeMB -Descending | 
        Select-Object -First 10 | 
        Format-Table -AutoSize
    
    Write-Host ""
    Write-Host "Top 20 largest files:" -ForegroundColor Green
    Get-ChildItem $unpackedPath -Recurse -File | 
        Sort-Object Length -Descending | 
        Select-Object -First 20 | 
        ForEach-Object {
            [PSCustomObject]@{
                File = $_.FullName.Replace((Resolve-Path $unpackedPath).Path + "\", "")
                SizeMB = [math]::Round($_.Length / 1MB, 2)
            }
        } | 
        Format-Table -AutoSize
    
    if (Test-Path $asarPath) {
        $asarSize = (Get-Item $asarPath).Length / 1MB
        Write-Host ""
        Write-Host "app.asar size: $([math]::Round($asarSize, 2)) MB" -ForegroundColor Cyan
    }
} else {
    Write-Host "Unpacked app not found at: $unpackedPath" -ForegroundColor Red
    Write-Host "Please run 'npm run build:win' first." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
