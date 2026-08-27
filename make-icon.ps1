<#
  BiliPure —— 生成应用图标 public/icon.ico
  ------------------------------------------------------------
  生成标准双条目 ICO：
    - 32x32 无压缩 DIB（小图标 / 列表视图）
    - 256x256 PNG（大图标 / 桌面）
  同时输出 icon_preview.png 便于人工检查。
  用法：powershell -ExecutionPolicy Bypass -File make-icon.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outIco = Join-Path $dir 'public\icon.ico'
$outPng = Join-Path $dir 'public\icon_preview.png'

function New-RoundPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Bilipure([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # 圆角蓝色底
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 47, 111, 237))
  $pad = $size * 0.03
  $g.FillPath($bg, (New-RoundPath $pad $pad ($size - 2 * $pad) ($size - 2 * $pad) ($size * 0.22)))

  # 白色播放三角
  $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tri.AddPolygon(@(
    [System.Drawing.PointF]::new($size * 0.40, $size * 0.30),
    [System.Drawing.PointF]::new($size * 0.40, $size * 0.70),
    [System.Drawing.PointF]::new($size * 0.67, $size * 0.50)
  ))
  $g.FillPath([System.Drawing.Brushes]::White, $tri)

  # 底部两条“书页”短线（暗示学习/列表）
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 255, 255), [Math]::Max(2, $size * 0.045))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($pen, $size * 0.27, $size * 0.80, $size * 0.48, $size * 0.80)
  $g.DrawLine($pen, $size * 0.54, $size * 0.80, $size * 0.74, $size * 0.80)

  $pen.Dispose()
  $bg.Dispose()
  $g.Dispose()
  return $bmp
}

# ---------- 32x32 DIB 条目 ----------
$small = Draw-Bilipure 32
$rect = New-Object System.Drawing.Rectangle 0, 0, 32, 32
$bmpData = $small.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $bmpData.Stride
$pix = New-Object byte[] ($stride * 32)
[System.Runtime.InteropServices.Marshal]::Copy($bmpData.Scan0, $pix, 0, $pix.Length)
$small.UnlockBits($bmpData)

$smallMs = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($smallMs)
$bw.Write([uint32]40)                    # BITMAPINFOHEADER 长度
$bw.Write([int32]32)                     # 宽
$bw.Write([int32]64)                     # 高（XOR + AND 双份）
$bw.Write([uint16]1)                     # 平面数
$bw.Write([uint16]32)                    # 位深
$bw.Write([uint32]0)                     # BI_RGB
$bw.Write([uint32](32 * 32 * 4 + 128))   # 图像数据大小
$bw.Write([int32]0); $bw.Write([int32]0) # 分辨率
$bw.Write([uint32]0); $bw.Write([uint32]0) # 颜色表
for ($y = 31; $y -ge 0; $y--) {          # 自下而上 BGRA
  for ($x = 0; $x -lt 32; $x++) {
    $o = $y * $stride + $x * 4
    $bw.Write($pix[$o]); $bw.Write($pix[$o + 1]); $bw.Write($pix[$o + 2]); $bw.Write($pix[$o + 3])
  }
}
$bw.Write([byte[]](New-Object byte[] 128)) # AND 掩码（全 0 = 不透明）
$smallBytes = $smallMs.ToArray()
$small.Dispose()

# ---------- 256x256 PNG 条目 ----------
$large = Draw-Bilipure 256
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/png' }
$large.Save($outPng, $enc, $null)          # 预览图
$pngMs = New-Object System.IO.MemoryStream
$large.Save($pngMs, $enc, $null)
$pngBytes = $pngMs.ToArray()
$large.Dispose()

# ---------- 组装 ICO ----------
$icoMs = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($icoMs)
$bw.Write([uint16]0)   # 保留
$bw.Write([uint16]1)   # 类型：图标
$bw.Write([uint16]2)   # 图片数量
$offset = 6 + 16 * 2

# 条目 1：32x32
$bw.Write([byte]32); $bw.Write([byte]32); $bw.Write([byte]0); $bw.Write([byte]0)
$bw.Write([uint16]1); $bw.Write([uint16]32)
$bw.Write([uint32]$smallBytes.Length); $bw.Write([uint32]$offset)
$offset += $smallBytes.Length

# 条目 2：256x256（宽高字节为 0 表示 256）
$bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([byte]0)
$bw.Write([uint16]1); $bw.Write([uint16]32)
$bw.Write([uint32]$pngBytes.Length); $bw.Write([uint32]$offset)

$bw.Write([byte[]]$smallBytes)
$bw.Write([byte[]]$pngBytes)
$bw.Flush()
[System.IO.File]::WriteAllBytes($outIco, $icoMs.ToArray())

Write-Host "图标已生成：$outIco ($($icoMs.Length) bytes)"
Write-Host "预览图：$outPng"
