# 阶段 5 打包图标工具:由 assets/pet/icons/icon.png 生成多尺寸 build/icon.ico
# (electron-builder Windows 安装包/可执行文件图标)。零第三方依赖(System.Drawing)。
# 用法:pwsh -File scripts/make-icon.ps1
# 输出:build/icon.ico(16/24/32/48/64/128/256,DIB 32bpp BGRA + AND 掩码)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'assets/pet/icons/icon.png'
$outDir = Join-Path $root 'build'
$out = Join-Path $outDir 'icon.ico'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$srcImg = [System.Drawing.Bitmap]::FromFile($src)
Write-Host "source: $($srcImg.Width)x$($srcImg.Height) pixel=$($srcImg.PixelFormat)"

# 诊断:角落/中心透明度与不透明像素包围盒(确认占位图有实际内容)
$bb = @{ minX = [int]::MaxValue; minY = [int]::MaxValue; maxX = -1; maxY = -1; count = 0 }
for ($y = 0; $y -lt $srcImg.Height; $y += 4) {
  for ($x = 0; $x -lt $srcImg.Width; $x += 4) {
    $c = $srcImg.GetPixel($x, $y)
    if ($c.A -gt 16) {
      $bb.minX = [Math]::Min($bb.minX, $x); $bb.minY = [Math]::Min($bb.minY, $y)
      $bb.maxX = [Math]::Max($bb.maxX, $x); $bb.maxY = [Math]::Max($bb.maxY, $y)
      $bb.count++
    }
  }
}
if ($bb.count -eq 0) { Write-Error "icon.png 全透明,无法生成图标"; exit 1 }
Write-Host "opaque bbox: ($($bb.minX),$($bb.minY))-($($bb.maxX),$($bb.maxY)) sampled=$($bb.count)"

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$dataList = [System.Collections.Generic.List[object]]::new()   # @{ size; dib(byte[]) }
$header = [System.Collections.Generic.List[byte]]::new()
$header.AddRange([byte[]](0, 0, 1, 0))                     # ICONDIR: reserved=0, type=1(icon)
$header.AddRange([BitConverter]::GetBytes([uint16]$sizes.Count))

foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($srcImg, 0, 0, $s, $s)
  $g.Dispose()

  $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $buf = New-Object byte[] ($stride * $s)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $buf, 0, $buf.Length)
  $bmp.UnlockBits($data)

  $dib = [System.Collections.Generic.List[byte]]::new()
  $dib.AddRange([BitConverter]::GetBytes([int32]40))          # BITMAPINFOHEADER
  $dib.AddRange([BitConverter]::GetBytes([int32]$s))          # biWidth
  $dib.AddRange([BitConverter]::GetBytes([int32]($s * 2)))    # biHeight (XOR + AND)
  $dib.AddRange([BitConverter]::GetBytes([uint16]1))          # biPlanes
  $dib.AddRange([BitConverter]::GetBytes([uint16]32))         # biBitCount
  $dib.AddRange([BitConverter]::GetBytes([int32]0))           # biCompression BI_RGB
  $dib.AddRange([BitConverter]::GetBytes([int32]($stride * $s)))  # biSizeImage
  $dib.AddRange([byte[]](0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))  # biClrUsed..biClrImportant

  # BGRA 像素,行序自底向上(ICO DIB 约定)
  for ($row = $s - 1; $row -ge 0; $row--) {
    for ($col = 0; $col -lt $s; $col++) {
      $i = $row * $stride + $col * 4
      $dib.Add($buf[$i]); $dib.Add($buf[$i + 1]); $dib.Add($buf[$i + 2]); $dib.Add($buf[$i + 3])
    }
  }
  # AND 掩码:1bpp,行补到 4 字节,全 0(透明由 alpha 通道承担)
  $andRowBytes = [int](([Math]::Ceiling($s / 32)) * 4)
  for ($row = 0; $row -lt $s; $row++) {
    for ($k = 0; $k -lt $andRowBytes; $k++) { $dib.Add([byte]0) }
  }
  $dataList.Add(@{ size = $s; bytes = $dib.ToArray() })
  $bmp.Dispose()
}

# 目录条目 + 数据段
$offset = 6 + 16 * $sizes.Count
foreach ($item in $dataList) {
  $s = $item.size
  $header.Add([byte]($(if ($s -ge 256) { 0 } else { $s })))   # 宽(256 用 0)
  $header.Add([byte]($(if ($s -ge 256) { 0 } else { $s })))   # 高
  $header.Add([byte]0)                                        # 调色板
  $header.Add([byte]0)                                        # 保留
  $header.AddRange([BitConverter]::GetBytes([uint16]1))       # planes
  $header.AddRange([BitConverter]::GetBytes([uint16]32))      # bitcount
  $header.AddRange([BitConverter]::GetBytes([uint32]$item.bytes.Length))
  $header.AddRange([BitConverter]::GetBytes([uint32]$offset))
  $offset += $item.bytes.Length
}

$all = [System.Collections.Generic.List[byte]]::new()
$all.AddRange($header.ToArray())
foreach ($item in $dataList) { $all.AddRange($item.bytes) }
[System.IO.File]::WriteAllBytes($out, $all.ToArray())
Write-Host "wrote $out ($($all.Count) bytes)"
$srcImg.Dispose()
