# Regenerates sources/menuBar/native/windows/happy.ico from the official logo.png at the repo root.
# Run on Windows: powershell -ExecutionPolicy Bypass -File scripts/generate-tray-icon.ps1
# The whole logo is scaled (no cropping) and clipped to a rounded tile, like the taskbar icon. Sizes
# up to 64 px are stored as 32-bit BMP entries (what the shell expects for small icons); 256 px is PNG.

Add-Type -AssemblyName System.Drawing

$packageRoot = Split-Path -Parent $PSScriptRoot
$logoPath = Join-Path $packageRoot "..\..\logo.png"
$outPath = Join-Path $packageRoot "sources\menuBar\native\windows\happy.ico"
$sizes = 16, 20, 24, 32, 40, 48, 64, 256

$source = [System.Drawing.Bitmap]::FromFile((Resolve-Path $logoPath))
$full = New-Object System.Drawing.Rectangle 0, 0, $source.Width, $source.Height

function Render([int]$size) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $radius = $size * 0.22
    $d = $radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90); $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.SetClip($path)
    $g.DrawImage($source, (New-Object System.Drawing.Rectangle 0, 0, $size, $size), $full, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    return $bitmap
}

function ToDib([System.Drawing.Bitmap]$bitmap) {
    $size = $bitmap.Width
    $ms = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter $ms
    $w.Write([int]40); $w.Write([int]$size); $w.Write([int]($size * 2))
    $w.Write([int16]1); $w.Write([int16]32); $w.Write([int]0)
    $w.Write([int]($size * $size * 4)); $w.Write([int]0); $w.Write([int]0); $w.Write([int]0); $w.Write([int]0)
    for ($y = $size - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $size; $x++) {
            $w.Write([int]$bitmap.GetPixel($x, $y).ToArgb())
        }
    }
    $maskStride = [int]([Math]::Ceiling($size / 32.0) * 4)
    $w.Write((New-Object byte[] ($maskStride * $size)))
    $w.Flush()
    return $ms.ToArray()
}

$images = @()
foreach ($size in $sizes) {
    $bitmap = Render $size
    if ($size -ge 256) {
        $ms = New-Object System.IO.MemoryStream
        $bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $images += , @{ Size = $size; Data = $ms.ToArray() }
    } else {
        $images += , @{ Size = $size; Data = (ToDib $bitmap) }
    }
    $bitmap.Dispose()
}
$source.Dispose()

$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([int16]0); $w.Write([int16]1); $w.Write([int16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($image in $images) {
    $dim = if ($image.Size -ge 256) { 0 } else { $image.Size }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([int16]1); $w.Write([int16]32)
    $w.Write([int]$image.Data.Length); $w.Write([int]$offset)
    $offset += $image.Data.Length
}
foreach ($image in $images) { $w.Write([byte[]]$image.Data) }
$w.Flush()
[System.IO.File]::WriteAllBytes($outPath, $out.ToArray())
Write-Host "Wrote $outPath"
