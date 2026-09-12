<#
  BiliNest —— 生成安装包
  用法：
    powershell -ExecutionPolicy Bypass -File installer\build.ps1
  说明：
    - 用 Inno Setup 6 编译 installer\bilinest.iss，产物在 dist\；
    - 只需要装一次 Inno Setup：winget install JRSoftware.InnoSetup
    - 版本号取自 package.json，请先把 installer\bilinest.iss 里的
      AppVersion 与 package.json 的 version 对齐（本脚本会替你检查）。
#>
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$iss = Join-Path $PSScriptRoot 'bilinest.iss'

if (-not (Test-Path -LiteralPath $iss)) { throw "找不到脚本：$iss" }

# 1) 找 ISCC.exe
$iscc = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $iscc) {
  throw @'
未找到 Inno Setup 6（ISCC.exe）。
请先安装（约 5MB，只需一次）：
    winget install JRSoftware.InnoSetup
或到 https://jrsoftware.org/isdl.php 下载。
'@
}

# 2) 版本号一致性检查：package.json 是唯一事实来源
#    注意必须显式 -Encoding UTF8：Windows PowerShell 5.1 默认按 ANSI 读文件，
#    package.json 里的中文会变成乱码，ConvertFrom-Json 直接报错。
$pkg = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'package.json') | ConvertFrom-Json
$issText = Get-Content -Raw -Encoding UTF8 -LiteralPath $iss
if ($issText -notmatch ('#define AppVersion "' + [regex]::Escape($pkg.version) + '"')) {
  throw "版本号不一致：package.json 是 $($pkg.version)，但 installer\bilinest.iss 里的 AppVersion 不是。请先对齐。"
}

# 3) 编译
Write-Host "ISCC : $iscc"
Write-Host "版本 : $($pkg.version)"
& $iscc $iss
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }

$out = Join-Path $root 'dist'
Get-ChildItem -LiteralPath $out -Filter '*.exe' | ForEach-Object {
  Write-Host ("产物 : {0}  ({1:N1} MB)" -f $_.FullName, ($_.Length / 1MB))
}
