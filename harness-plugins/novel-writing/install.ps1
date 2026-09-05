# Novel Writing 插件安装/升级脚本（novel-studio 内置版）
#
# 与旧版不同：
#   - headless patch 采用“区块合并”安装：只替换本插件维护的
#     “Novel Studio 创作内核注入”区块，用户自己加的其它 patch 条目原样保留；
#   - 兼容旧版（v0.x）安装留下的无标记区块，升级时自动移除；
#   - 带版本号与 -DryRun / -Uninstall，重复安装不会堆积 .bak 文件；
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

# 与 harness-plugins/novel-writing/plugin.json 的 version 保持一致。
$script:Version = '0.7.0'

$srcTools = Join-Path $root 'novel-tools.mjs'
$srcAgent = Join-Path $root 'agent.cordis.yml'
$srcPreset = Join-Path $root 'preset.yml'
$srcPatch = Join-Path $root 'headless-cordis.patch.yml'

$blockStart = '# ═══ Novel Studio 创作内核注入（headless）═══════════════════════════════════'
$blockEnd = '# ═══ 区块结束 ═══'
# 旧版（v0.x）安装的区块没有标记，以这段注释开头、以 baseUrl 行收尾。
$legacyMarker = 'Novel Studio 创作内核注入'

function Say($msg) { Write-Host $msg }

function Backup-File($path) {
  if (-not (Test-Path $path)) { return }
  $bak = "$path.bak-$(Get-Date -Format yyyyMMddHHmmss)"
  Copy-Item $path $bak
  Say "    已备份原文件 -> $bak"
}

# 以无 BOM 的 UTF-8 写文件（YAML 加载器对无 BOM 最宽容）。
function Write-Utf8NoBom($path, $content) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $content, $utf8)
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
  # 旧版区块：从旧注释标记到其后最后一个 baseUrl 行。
  $legacy = -1; $lastBase = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($legacy -lt 0 -and $lines[$i].Contains($legacyMarker)) { $legacy = $i }
    if ($legacy -ge 0 -and $lines[$i] -match '^\s*baseUrl:') { $lastBase = $i }
  }
  if ($legacy -ge 0) {
    $end = $lines.Count - 1
    if ($lastBase -ge $legacy) { $end = $lastBase }
    return @($legacy, $end)
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
  if (Test-Path $presetDest) {
    if ($DryRun) { Say "    [DryRun] 将删除 $presetDest" } else { Remove-Item $presetDest -Recurse -Force; Say "    已删除 GUI preset" }
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
    if ($DryRun) { Say "    [DryRun] 将删除 $headlessTools" } else { Remove-Item $headlessTools -Force; Say "    已删除 headless 工具文件" }
  }
  Say "✔ 卸载完成。"
  exit 0
}

Say "==> novel-writing 插件 v$script:Version 安装（内置 · 面向 novel-studio）"
if (-not (Test-Path $srcTools)) { Write-Error "缺少 $srcTools"; exit 1 }
if (-not (Test-Path $srcAgent)) { Write-Error "缺少 $srcAgent"; exit 1 }
if (-not (Test-Path $srcPatch)) { Write-Error "缺少 $srcPatch"; exit 1 }

Say '==> 1/2 GUI agent preset（dsh 交互会话用）'
if (-not (Test-Path $presetDest)) {
  if ($DryRun) { Say "    [DryRun] 将创建 $presetDest" } else { New-Item -ItemType Directory -Path $presetDest -Force | Out-Null; Say "    已创建 preset 目录" }
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
  if ($DryRun) { Say "    [DryRun] 将创建 $headlessDir" } else { New-Item -ItemType Directory -Path $headlessDir -Force | Out-Null }
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

Say ''
Say '✔ 完成。'
Say '  1) 若升级了 novel-studio 服务端文件（db.js/server.js/harness.js），请重启：npm start'
Say '  2) 打开 novel-studio 使用 AI 创作即可，无需在 dsh 里手动选 preset。'
Say '  3) 验证：cd <你的 deepseek-harness 目录>; pnpm dsh --profile headless "只输出一行：你当前可用的全部工具名称，用逗号分隔"'
Say '     期望出现：novel_context, novel_works, novel_lookup, novel_scan, novel_style_contract, novel_event_add, novel_memory_update, novel_foreshadows, novel_foreshadow_update, novel_consistency, novel_blueprint, novel_review, novel_chapter_save'
