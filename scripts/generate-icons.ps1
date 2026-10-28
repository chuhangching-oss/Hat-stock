# Generate PWA icons (icon-192 / icon-512 / apple-touch-icon)
# Uses built-in .NET System.Drawing - no extra packages needed.
# Run:  powershell -ExecutionPolicy Bypass -File scripts\generate-icons.ps1
# Icon design: white knitted beanie on blue background (#1d4ed8).

Add-Type -AssemblyName System.Drawing

$iconDir = Join-Path $PSScriptRoot "..\public\icons"
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null

function New-Icon([int]$size, [string]$outFile) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $scale = $size / 100.0
    $bg   = [System.Drawing.Color]::FromArgb(255, 29, 78, 216)   # #1d4ed8
    $bgBr = New-Object System.Drawing.SolidBrush($bg)
    $wBr  = [System.Drawing.Brushes]::White

    # full-bleed background (maskable-compatible)
    $g.FillRectangle($bgBr, 0, 0, $size, $size)

    # pom ball
    $g.FillEllipse($wBr, (42 * $scale), (15 * $scale), (16 * $scale), (16 * $scale))
    # beanie dome (upper half ellipse)
    $g.FillPie($wBr, (28 * $scale), (30 * $scale), (44 * $scale), (44 * $scale), 180, 180)
    # brim (rounded rect)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bx = 24 * $scale; $by = 52 * $scale; $bw = 52 * $scale; $bh = 16 * $scale; $d = 16 * $scale
    $path.AddArc($bx, $by, $d, $d, 180, 90)
    $path.AddArc(($bx + $bw - $d), $by, $d, $d, 270, 90)
    $path.AddArc(($bx + $bw - $d), ($by + $bh - $d), $d, $d, 0, 90)
    $path.AddArc($bx, ($by + $bh - $d), $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($wBr, $path)
    $path.Dispose()

    # knit ribs (bg-colored vertical lines on brim)
    $pen = New-Object System.Drawing.Pen($bg, [Math]::Max(2, 1.6 * $scale))
    foreach ($x in @(33, 41.5, 50, 58.5, 67)) {
        $g.DrawLine($pen, ($x * $scale), (53.5 * $scale), ($x * $scale), (66.5 * $scale))
    }
    $pen.Dispose()
    $g.Dispose()

    $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "OK $outFile ($size x $size)"
}

New-Icon 512 (Join-Path $iconDir "icon-512.png")
New-Icon 192 (Join-Path $iconDir "icon-192.png")
New-Icon 180 (Join-Path $iconDir "apple-touch-icon.png")

Write-Host "All icons generated under public/icons/"
