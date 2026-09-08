# BiliNest - 创建桌面快捷方式
# 双击运行此脚本，会在桌面生成带图标的 BiliNest 快捷方式

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$exePath = Join-Path $scriptDir "BiliNest.exe"
$iconPath = Join-Path $scriptDir "icon.ico"

if (-not (Test-Path $exePath)) {
    Write-Host "BiliNest.exe not found in $scriptDir" -ForegroundColor Red
    pause
    exit 1
}

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "BiliNest.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $scriptDir
$shortcut.Description = "BiliNest - Bilibili Study Player"
if (Test-Path $iconPath) {
    $shortcut.IconLocation = "$iconPath,0"
}
$shortcut.Save()

Write-Host "Done! Shortcut created on Desktop." -ForegroundColor Green
Write-Host "Double-click the shortcut to start BiliNest." -ForegroundColor Cyan
pause
