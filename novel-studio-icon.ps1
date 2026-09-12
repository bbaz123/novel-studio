# Generates a custom icon for Novel Studio (小说工坊).
# Usage:  powershell -ExecutionPolicy Bypass -File novel-studio-icon.ps1 [-Preview]
#   -Preview : only render assets\preview.png (multi-size strip) and stop.
#   default  : render preview, pack assets\novel-studio.ico (16..256), apply to the desktop shortcut.
param([switch]$Preview)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$assetDir = Join-Path $project 'assets'
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null

function New-RoundRectPath {
  param([float]$x,[float]$y,[float]$w,[float]$h,[float]$r)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2.0
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Capsule {
  param([float]$x,[float]$y,[float]$w,[float]$h)
  $r = $h / 2.0
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, $h, $h, 90, 180)
  $p.AddArc($x + $w - $h, $y, $h, $h, 270, 180)
  $p.CloseFigure()
  return $p
}

function Draw-Master {
  $size = 256
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  # ---- rounded-square tile, diagonal indigo -> cyan gradient (brand #6366f1 / #0ea5e9)
  $bgPath = New-RoundRectPath 0 0 256 256 58
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, 256, 256)),
    [System.Drawing.ColorTranslator]::FromHtml('#6366f1'),
    [System.Drawing.ColorTranslator]::FromHtml('#0ea5e9'),
    38.0)
  $g.FillPath($grad, $bgPath)
  $rim = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(70, 255, 255, 255), 2.0)
  $g.DrawPath($rim, $bgPath)

  # ---- artwork, optically centered
  $g.TranslateTransform(-4, 8)

  # book thickness / soft drop shade (offset under the cover)
  $shade = [System.Drawing.Color]::FromArgb(110, 15, 23, 42)
  $g.FillPath((New-Object System.Drawing.SolidBrush($shade)), (New-RoundRectPath 95 77 84 116 12))

  # gold bookmark tab tucked over the top edge of the cover
  $gold = [System.Drawing.ColorTranslator]::FromHtml('#fbbf24')
  $g.FillPath((New-Object System.Drawing.SolidBrush($gold)), (New-RoundRectPath 146 54 12 20 5))

  # white cover (drawn over the tab's lower part so it reads as tucked in)
  $coverPath = New-RoundRectPath 90 70 84 116 12
  $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)), $coverPath)

  # indigo "text lines"
  $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#6366f1'))
  $lines = @(
    @{ x = 102.0; w = 60.0; y = 94.0 },
    @{ x = 114.0; w = 48.0; y = 112.0 },
    @{ x = 114.0; w = 60.0; y = 130.0 },
    @{ x = 114.0; w = 32.0; y = 148.0 }
  )
  foreach ($ln in $lines) {
    $g.FillPath($lineBrush, (New-Capsule $ln.x $ln.y $ln.w 8.0))
  }

  $g.Dispose()
  return $bmp
}

$master = Draw-Master

if ($Preview) {
  # ---- multi-size strip on a neutral panel so small sizes can be judged
  $px = 24; $py = 24
  $smallY = $py + 88
  $sx1 = $px + 256 + 32
  $W = $sx1 + 48 + 20 + 32 + 20 + 16 + 24
  $H = $py + 256 + 24
  $panel = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $pg = [System.Drawing.Graphics]::FromImage($panel)
  $pg.Clear([System.Drawing.ColorTranslator]::FromHtml('#7d8494'))
  $pg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $pg.DrawImage($master, $px, $py, 256, 256)
  $pg.DrawImage($master, $sx1, $smallY, 48, 48)
  $pg.DrawImage($master, $sx1 + 68, $smallY + 8, 32, 32)
  $pg.DrawImage($master, $sx1 + 120, $smallY + 16, 16, 16)
  $pg.DrawString('256       48   32   16', (New-Object System.Drawing.Font('Segoe UI', 13)),
    (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 255, 255, 255))),
    $px, $py + 256 + 6)
  $pg.Dispose()
  $previewPath = Join-Path $assetDir 'preview.png'
  $panel.Save($previewPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "Preview: $previewPath"
  $master.Dispose()
  exit 0
}

# ---- pack multi-resolution ICO (PNG-compressed entries, Vista+)
$sizes = @(16, 24, 32, 48, 64, 256)
$pngs = @()
foreach ($s in $sizes) {
  $b = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gb = [System.Drawing.Graphics]::FromImage($b)
  $gb.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $gb.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gb.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $gb.Clear([System.Drawing.Color]::Transparent)
  $gb.DrawImage($master, 0, 0, $s, $s)
  $gb.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , $ms.ToArray()
  $ms.Dispose()
  $b.Dispose()
}
$master.Dispose()

$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($ico)
$w.Write([uint16]0)                 # reserved
$w.Write([uint16]1)                 # type: icon
$w.Write([uint16]$pngs.Count)       # image count
$offset = 6 + 16 * $pngs.Count
for ($i = 0; $i -lt $pngs.Count; $i++) {
  $dim = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([byte]$dim)              # width
  $w.Write([byte]$dim)              # height
  $w.Write([byte]0)                 # palette
  $w.Write([byte]0)                 # reserved
  $w.Write([uint16]1)               # planes
  $w.Write([uint16]32)              # bpp
  $w.Write([uint32]$pngs[$i].Length)
  $w.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush()
$icoPath = Join-Path $assetDir 'novel-studio.ico'
[System.IO.File]::WriteAllBytes($icoPath, $ico.ToArray())
$w.Dispose(); $ico.Dispose()
Write-Host "Icon: $icoPath"

# ---- apply to the desktop shortcut (found by target path to avoid encoding pitfalls)
$desktop = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
$target = Join-Path $project 'start-novel-studio.cmd'
$shortcutPath = $null
foreach ($lnk in (Get-ChildItem $desktop -Filter *.lnk)) {
  $sc = $ws.CreateShortcut($lnk.FullName)
  if ($sc.TargetPath -ieq $target) { $shortcutPath = $lnk.FullName; break }
}
if ($shortcutPath) {
  $sc = $ws.CreateShortcut($shortcutPath)
  $sc.IconLocation = $icoPath
  $sc.Save()
  Write-Host "Shortcut icon updated: $shortcutPath"
} else {
  Write-Host "WARNING: shortcut for $target not found on desktop"
}
