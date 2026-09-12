# Novel Writing 插件安装/升级脚本（novel-studio 内置版）
#
# 与旧版不同：
#   - headless patch 采用“区块合并”安装：只替换本插件维护的
#     “Novel Studio 创作内核注入”区块，用户自己加的其它 patch 条目原样保留；
#   - 兼容旧版（v0.x）安装留下的无标记区块，升级时自动移除；
#   - 带版本号与 -DryRun / -Uninstall，备份保留最近 5 个 .bak、每次备份后自动清理更早的；
#   - 工具代码（novel-tools.mjs）单一来源，两个安装点（headless / GUI preset）同源复制。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1             # 安装/升级
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun     # 预演，不写文件
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall  # 移除（preset 删除 + 区块移除）
param(
  [switch]$DryRun,
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$presetDest = Join-Path $dshHome '.agent-presets\novel-writing'
$headlessDir = Join-Path $dshHome 'profiles\headless'

# 版本号随 plugin.json 的 version 字段（运行时读取，不再硬编码）。
$script:Version = ([System.IO.File]::ReadAllText((Join-Path $root 'plugin.json')) | ConvertFrom-Json).version

$srcTools = Join-Path $root 'novel-tools.mjs'
$srcAgent = Join-Path $root 'agent.cordis.yml'
$srcPreset = Join-Path $root 'preset.yml'
$srcPatch = Join-Path $root 'headless-cordis.patch.yml'

$blockStart = '# ═══ Novel Studio 创作内核注入（headless）═══════════════════════════════════'
$blockEnd = '# ═══ 区块结束 ═══'
# 旧版（v0.x）安装的区块没有标记，以这段注释开头、以 baseUrl 行收尾。
$legacyMarker = 'Novel Studio 创作内核注入'

function Say($msg) { Write-Host $msg }

# 备份保留最近 N 个 .bak，每次备份后自动清理更早的备份，避免重复安装堆积。
$script:MaxBackups = 5
$script:backups = @()

function Cleanup-Backups($path) {
  $dir = Split-Path $path
  $name = [System.IO.Path]::GetFileName($path)
  $baks = @(Get-ChildItem -Path (Join-Path $dir "$name.bak-*") -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  if ($baks.Count -le $script:MaxBackups) { return }
  foreach ($old in $baks[$script:MaxBackups..($baks.Count - 1)]) {
    Remove-Item $old.FullName -Force -ErrorAction SilentlyContinue
    Say "    已清理旧备份 -> $($old.Name)"
  }
}

function Backup-File($path) {
  if (-not (Test-Path $path)) { return }
  $bak = "$path.bak-$(Get-Date -Format yyyyMMddHHmmssfff)"
  Copy-Item $path $bak
  Say "    已备份原文件 -> $bak"
  $script:backups += @{ Target = $path; Bak = $bak; IsDir = $false }
  Cleanup-Backups $path
}

function Backup-Directory($path) {
  if (-not (Test-Path $path)) { return }
  $bak = "$path.bak-$(Get-Date -Format yyyyMMddHHmmssfff)"
  Copy-Item $path $bak -Recurse
  Say "    已备份原目录 -> $bak"
  $script:backups += @{ Target = $path; Bak = $bak; IsDir = $true }
  $dir = Split-Path $path
  $name = [System.IO.Path]::GetFileName($path)
  $dirBaks = @(Get-ChildItem -Path (Join-Path $dir "$name.bak-*") -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
  if ($dirBaks.Count -gt $script:MaxBackups) {
    foreach ($old in $dirBaks[$script:MaxBackups..($dirBaks.Count - 1)]) {
      Remove-Item $old.FullName -Recurse -Force -ErrorAction SilentlyContinue
      Say "    已清理旧目录备份 -> $($old.Name)"
    }
  }
}

function Restore-Backups() {
  $baks = @($script:backups)
  for ($i = $baks.Count - 1; $i -ge 0; $i--) {
    $b = $baks[$i]
    if (-not (Test-Path $b.Bak)) { continue }
    if ($b.IsDir) {
      if (Test-Path $b.Target) { Remove-Item $b.Target -Recurse -Force -ErrorAction SilentlyContinue }
      Copy-Item $b.Bak $b.Target -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Copy-Item $b.Bak $b.Target -Force -ErrorAction SilentlyContinue
    }
    Say "    已回滚 -> $($b.Target)"
  }
}

# 以无 BOM 的 UTF-8 写文件（YAML 加载器对无 BOM 最宽容）；原子写：先写同目录 .tmp 再 Move-Item 覆盖。
function Write-Utf8NoBom($path, $content) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $tmp = "$path.tmp"
  [System.IO.File]::WriteAllText($tmp, $content, $utf8)
  Move-Item -Force $tmp $path
}

function Read-Lines($path) {
  if (-not (Test-Path $path)) { return @() }
  $content = [System.IO.File]::ReadAllText($path)
  return @($content -split "`r?`n")
}

# 找本插件新旧区块的行范围（0 基）。返回 @($startIdx, $endIdx)，无则 @(-1, -1)。
function Find-Block($lines) {
  $startIdx = -1; $endIdx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -eq $blockStart.Trim()) { $startIdx = $i }
    if ($startIdx -ge 0 -and $lines[$i].Trim() -eq $blockEnd.Trim()) { $endIdx = $i; break }
  }
  if ($startIdx -ge 0 -and $endIdx -ge 0) { return @($startIdx, $endIdx) }
  # 旧版区块：从旧注释标记到其后第一个 baseUrl 行（不再吞掉用户后加的其它条目）。
  $legacy = -1; $firstBase = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($legacy -lt 0 -and $lines[$i].Contains($legacyMarker)) { $legacy = $i }
    if ($legacy -ge 0 -and $firstBase -lt 0 -and $lines[$i] -match '^\s*baseUrl:') { $firstBase = $i; break }
  }
  if ($legacy -ge 0) {
    if ($firstBase -ge $legacy) {
      Say '    检测到旧版区块，已按首个 baseUrl 行裁剪，请人工核对未删内容'
      return @($legacy, $firstBase)
    }
    return @($legacy, $lines.Count - 1)
  }
  return @(-1, -1)
}

# 合并安装：替换本插件区块（新旧都识别），不存在则追加；其它条目原样保留。
function Merge-HeadlessPatch($patchPath) {
  $fragment = [System.IO.File]::ReadAllText($srcPatch)
  $fragment = $fragment.TrimEnd("`r", "`n") + "`r`n"
  $lines = Read-Lines $patchPath
  if ($lines.Count -eq 0) { return $fragment.TrimEnd() + "`r`n" }
  $range = Find-Block $lines
  if ($range[0] -ge 0 -and $range[1] -ge 0) {
    $head = ''
    if ($range[0] -gt 0) { $head = ($lines[0..($range[0] - 1)] -join "`r`n") }
    $tail = ''
    if ($range[1] -lt ($lines.Count - 1)) { $tail = ($lines[($range[1] + 1)..($lines.Count - 1)] -join "`r`n") }
    $parts = @()
    if ($head.Trim().Length -gt 0) { $parts += $head.TrimEnd() }
    $parts += $fragment.TrimEnd()
    if ($tail.Trim().Length -gt 0) { $parts += $tail.TrimStart() }
    return (($parts -join "`r`n`r`n").TrimEnd() + "`r`n")
  }
  $content = ($lines -join "`r`n")
  return ($content.TrimEnd() + "`r`n`r`n" + $fragment.TrimEnd() + "`r`n")
}

function Remove-HeadlessBlock($patchPath) {
  $lines = Read-Lines $patchPath
  if ($lines.Count -eq 0) { return '' }
  $range = Find-Block $lines
  if ($range[0] -lt 0 -or $range[1] -lt 0) { return ($lines -join "`r`n") }
  $parts = @()
  if ($range[0] -gt 0) { $parts += ($lines[0..($range[0] - 1)] -join "`r`n") }
  if ($range[1] -lt ($lines.Count - 1)) { $parts += ($lines[($range[1] + 1)..($lines.Count - 1)] -join "`r`n") }
  return (($parts -join "`r`n").TrimEnd() + "`r`n")
}

if ($Uninstall) {
  Say "==> 卸载 novel-writing 插件 v$script:Version"
  try {
    if (Test-Path $presetDest) {
      if ($DryRun) { Say "    [DryRun] 将删除 $presetDest" }
      else {
        Backup-Directory $presetDest
        Remove-Item $presetDest -Recurse -Force
        Say "    已删除 GUI preset"
      }
    } else {
      Say "    GUI preset 不存在，跳过"
    }
    $patchPath = Join-Path $headlessDir 'cordis.patch.yml'
    if (Test-Path $patchPath) {
      $new = Remove-HeadlessBlock $patchPath
      if ($DryRun) {
        Say "    [DryRun] 将从 headless patch 移除 Novel Studio 区块"
      } else {
        Backup-File $patchPath
        Write-Utf8NoBom $patchPath $new
        Say "    已从 headless patch 移除 Novel Studio 区块"
      }
    }
    $headlessTools = Join-Path $headlessDir 'novel-tools.mjs'
    if (Test-Path $headlessTools) {
      if ($DryRun) { Say "    [DryRun] 将删除 $headlessTools" }
      else {
        Backup-File $headlessTools
        Remove-Item $headlessTools -Force
        Say "    已删除 headless 工具文件"
      }
    }
    Say "✔ 卸载完成。"
    exit 0
  } catch {
    Restore-Backups
    Write-Error "卸载失败，已回滚已备份文件：$($_.Exception.Message)"
    exit 1
  }
}

Say "==> novel-writing 插件 v$script:Version 安装（内置 · 面向 novel-studio）"
if (-not (Test-Path $srcTools)) { Write-Error "缺少 $srcTools"; exit 1 }
if (-not (Test-Path $srcAgent)) { Write-Error "缺少 $srcAgent"; exit 1 }
if (-not (Test-Path $srcPreset)) { Write-Error "缺少 $srcPreset"; exit 1 }
if (-not (Test-Path $srcPatch)) { Write-Error "缺少 $srcPatch"; exit 1 }

$createdPreset = $false
$createdHeadless = $false
try {
  Say '==> 1/2 GUI agent preset（dsh 交互会话用）'
  if (-not (Test-Path $presetDest)) {
    if ($DryRun) { Say "    [DryRun] 将创建 $presetDest" }
    else {
      New-Item -ItemType Directory -Path $presetDest -Force | Out-Null
      $createdPreset = $true
      Say "    已创建 preset 目录"
    }
  } else {
    Say "    已存在旧 preset，将覆盖更新（preset 内容由本仓库统一维护）"
  }
  if (-not $DryRun) {
    if (Test-Path (Join-Path $presetDest 'agent.cordis.yml')) { Backup-File (Join-Path $presetDest 'agent.cordis.yml') }
    Copy-Item $srcAgent (Join-Path $presetDest 'agent.cordis.yml') -Force
    Copy-Item $srcPreset (Join-Path $presetDest 'preset.yml') -Force
    Copy-Item $srcTools (Join-Path $presetDest 'novel-tools.mjs') -Force
    # 清理旧版（v0.x 上游 preset）残留文件：本 preset 目录只应包含本仓库维护的文件。
    $legacyReadme = Join-Path $presetDest 'README.md'
    if (Test-Path $legacyReadme) { Remove-Item $legacyReadme -Force; Say '    已清理旧版 preset 残留 README.md' }
    Say "    preset 已安装：$presetDest"
  } else {
    Say "    [DryRun] preset 文件将复制到 $presetDest"
  }

  Say '==> 2/2 headless profile 注入（novel-studio 后台 dsh 任务）'
  if (-not (Test-Path $headlessDir)) {
    if ($DryRun) { Say "    [DryRun] 将创建 $headlessDir" }
    else {
      New-Item -ItemType Directory -Path $headlessDir -Force | Out-Null
      $createdHeadless = $true
    }
  }
  $patchPath = Join-Path $headlessDir 'cordis.patch.yml'
  if (-not $DryRun) {
    Backup-File $patchPath
    $merged = Merge-HeadlessPatch $patchPath
    Write-Utf8NoBom $patchPath $merged
    Copy-Item $srcTools (Join-Path $headlessDir 'novel-tools.mjs') -Force
    Say "    headless patch 已合并注入（保留你原有的其它 patch 条目）"
  } else {
    Say "    [DryRun] 将把 Novel Studio 区块合并进 $patchPath，并复制 novel-tools.mjs"
  }
} catch {
  Restore-Backups
  if ($createdPreset -and (Test-Path $presetDest)) { Remove-Item $presetDest -Recurse -Force -ErrorAction SilentlyContinue; Say "    已清理新建 preset 目录" }
  if ($createdHeadless -and (Test-Path $headlessDir)) { Remove-Item $headlessDir -Recurse -Force -ErrorAction SilentlyContinue; Say "    已清理新建 headless 目录" }
  Write-Error "安装失败，已回滚已备份文件：$($_.Exception.Message)"
  exit 1
}

Say ''
Say '✔ 完成。'
Say '  1) 若升级了 novel-studio 服务端文件（db.js/server.js/harness.js），请重启：npm start'
Say '  2) 打开 novel-studio 使用 AI 创作即可，无需在 dsh 里手动选 preset。'
Say '  3) 验证：cd <你的 deepseek-harness 目录>; pnpm dsh --profile headless "只输出一行：你当前可用的全部工具名称，用逗号分隔"'
Say '     期望出现：novel_context, novel_works, novel_lookup, novel_scan, novel_style_contract, novel_event_add, novel_memory_update, novel_foreshadows, novel_foreshadow_update, novel_consistency, novel_blueprint, novel_review, novel_chapter_save'
