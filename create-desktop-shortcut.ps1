# Creates a desktop shortcut for Novel Studio.
$ErrorActionPreference = 'Stop'
$desktop = [Environment]::GetFolderPath('Desktop')
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $project 'start-novel-studio.cmd'
$shortcutPath = Join-Path $desktop '小说工坊.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcutPath)
$sc.TargetPath = $target
$sc.WorkingDirectory = $project
$icon = Join-Path $project 'assets\novel-studio.ico'
$sc.IconLocation = $icon
$sc.Description = 'Novel Studio 小说创作工坊'
$sc.Save()

Write-Host "Shortcut created: $shortcutPath"
