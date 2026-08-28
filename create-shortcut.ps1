<#
  BiliNest —— 创建桌面快捷方式
  用法：
    powershell -ExecutionPolicy Bypass -File create-shortcut.ps1
  说明：
    - 快捷方式指向 launcher.vbs（启动本地代理并打开浏览器）；
    - 若以后移动了项目目录，重新运行本脚本即可更新。
#>
$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher   = Join-Path $projectDir 'launcher.vbs'
$icon       = Join-Path $projectDir 'public\icon.ico'
$desktop    = [Environment]::GetFolderPath('Desktop')
$lnkPath    = Join-Path $desktop 'BiliNest.lnk'

if (-not (Test-Path -LiteralPath $launcher)) { throw "未找到启动器：$launcher" }
if (-not (Test-Path -LiteralPath $icon))     { throw "未找到图标：$icon" }

$ws  = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath       = Join-Path $env:windir 'System32\wscript.exe'
$lnk.Arguments        = '"' + $launcher + '"'
$lnk.WorkingDirectory = $projectDir
$lnk.IconLocation     = $icon
$lnk.Description      = 'BiliNest —— 无干扰 B 站学习播放器'
$lnk.WindowStyle      = 7
$lnk.Save()

Write-Host "桌面快捷方式已创建：$lnkPath"
