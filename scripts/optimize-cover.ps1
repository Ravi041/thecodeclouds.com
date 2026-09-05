param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (Test-Path -LiteralPath $Destination) { throw 'Choose a new filename; existing images are not overwritten.' }
$sourceImage = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source).Path)
try {
  $coverWidth = [Math]::Min(1200, $sourceImage.Width)
  $coverHeight = [int][Math]::Round($sourceImage.Height * $coverWidth / $sourceImage.Width)
  $bitmap = New-Object System.Drawing.Bitmap($coverWidth, $coverHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $encoderParameters = New-Object System.Drawing.Imaging.EncoderParameters(1)
  try {
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($sourceImage, 0, 0, $coverWidth, $coverHeight)
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg'
    $encoderParameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]85)
    $bitmap.Save([System.IO.Path]::GetFullPath($Destination), $codec, $encoderParameters)
    Write-Output "$Destination : $coverWidth x $coverHeight"
  } finally { $encoderParameters.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
} finally { $sourceImage.Dispose() }
