param(
  [Parameter(Mandatory = $true)][string]$InputPng,
  [Parameter(Mandatory = $true)][string]$OutputIco
)

Add-Type -AssemblyName System.Drawing

$source = [System.Drawing.Image]::FromFile($InputPng)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()

try {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($source, 0, 0, $size, $size)
      $stream = New-Object System.IO.MemoryStream
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $images += ,$stream.ToArray()
      $stream.Dispose()
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
} finally {
  $source.Dispose()
}

$file = [System.IO.File]::Open($OutputIco, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter($file)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$images.Count)
  $offset = 6 + (16 * $images.Count)
  for ($i = 0; $i -lt $images.Count; $i++) {
    $sizeByte = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
    $writer.Write([byte]$sizeByte)
    $writer.Write([byte]$sizeByte)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$images[$i].Length)
    $writer.Write([uint32]$offset)
    $offset += $images[$i].Length
  }
  foreach ($image in $images) {
    $writer.Write($image)
  }
} finally {
  $writer.Dispose()
  $file.Dispose()
}
