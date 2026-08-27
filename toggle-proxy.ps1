# =====================================================================
# antigravity-add-model - Toggle Proxy Script
# Usage:
#   .\toggle-proxy.ps1                  # Auto toggle (Enabled <-> Paused)
#   .\toggle-proxy.ps1 -Action Enable   # Force enable
#   .\toggle-proxy.ps1 -Action Disable  # Force pause (pure official mode)
#   .\toggle-proxy.ps1 -Action Status   # View status only
# =====================================================================
param(
    [ValidateSet('Toggle', 'Enable', 'Disable', 'Status')]
    [string]$Action = 'Toggle',
    [string]$IdePath = "$env:LOCALAPPDATA\Programs\Antigravity IDE",
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

$AppRoot = Join-Path $IdePath 'resources\app'
$MainJs = Join-Path $AppRoot 'out\main.js'
$ProductJson = Join-Path $AppRoot 'product.json'
$SettingsPath = Join-Path $env:APPDATA 'Antigravity IDE\User\settings.json'
$DefaultProxyUrl = 'http://127.0.0.1:50999/v1internal/xxxxxxx'
$BootstrapHeader = '/* antigravity-add-model bootstrap */'
$BootstrapImport = "import('./proxy/bootstrap.js').catch(function(e){console.error('[agy-proxy] import failed',e);});"
$FullBootstrap = $BootstrapHeader + "`r`n" + $BootstrapImport + "`r`n"

# -- 1. Path check
if (-not (Test-Path $MainJs)) {
    Write-Host "[-] Not found: $MainJs" -ForegroundColor Red
    Write-Host "Please ensure -IdePath points to Antigravity IDE directory" -ForegroundColor Yellow
    exit 1
}

# -- 2. Check current status
$mainContent = [System.IO.File]::ReadAllText($MainJs)
$isBootstrapInjected = $mainContent.Contains($BootstrapImport) -and (-not $mainContent.Contains("// $BootstrapImport"))

$hasSettingsUrl = $false
if (Test-Path $SettingsPath) {
    $settingsContent = [System.IO.File]::ReadAllText($SettingsPath)
    if ($settingsContent.Contains('jetski.cloudCodeUrl')) {
        $hasSettingsUrl = $true
    }
}

$isCurrentlyEnabled = ($isBootstrapInjected -or $hasSettingsUrl)

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Antigravity Proxy Management" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan

if ($Action -eq 'Status') {
    if ($isCurrentlyEnabled) {
        Write-Host "Current Status: [ENABLED / ON]" -ForegroundColor Green
        Write-Host "  - Main Process Injected: $isBootstrapInjected" -ForegroundColor Gray
        Write-Host "  - Settings.json Endpoint: $hasSettingsUrl" -ForegroundColor Gray
    } else {
        Write-Host "Current Status: [PAUSED / OFF (Official Mode)]" -ForegroundColor DarkYellow
    }
    Write-Host "============================================" -ForegroundColor Cyan
    exit 0
}

# Determine target state
$targetEnable = $false
if ($Action -eq 'Toggle') {
    $targetEnable = -not $isCurrentlyEnabled
} elseif ($Action -eq 'Enable') {
    $targetEnable = $true
} else {
    $targetEnable = $false
}

# -- 3. Execute change
$ideProcesses = Get-Process -Name 'Antigravity IDE' -ErrorAction SilentlyContinue
$wasRunning = ($ideProcesses.Count -gt 0)

if ($wasRunning -and (-not $NoRestart)) {
    Write-Host "Closing Antigravity IDE to apply settings..." -ForegroundColor Yellow
    Stop-Process -Name 'Antigravity IDE' -Force -ErrorAction SilentlyContinue
    Stop-Process -Name 'language_server_windows_x64' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

if ($targetEnable) {
    Write-Host "Enabling Proxy..." -ForegroundColor Cyan
    
    # 3.1 Restore injection in out/main.js
    if ($mainContent.Contains("// $BootstrapImport")) {
        $mainContent = $mainContent.Replace("// $BootstrapImport", $BootstrapImport)
        $mainContent = $mainContent.Replace("// $BootstrapHeader", $BootstrapHeader)
    } elseif (-not $mainContent.Contains($BootstrapImport)) {
        $mainContent = $FullBootstrap + $mainContent
    }
    [System.IO.File]::WriteAllText($MainJs, $mainContent)
    Write-Host "  [OK] Main process proxy injection enabled" -ForegroundColor Green

    # 3.2 Write settings.json
    if (Test-Path $SettingsPath) {
        $st = [System.IO.File]::ReadAllText($SettingsPath)
        if (-not $st.Contains('jetski.cloudCodeUrl')) {
            $closeIdx = $st.LastIndexOf('}')
            if ($closeIdx -ge 0) {
                $before = $st.Substring(0, $closeIdx).TrimEnd()
                $needsComma = $false
                if ($before.Length -gt 1) {
                    $lastChar = $before.Substring($before.Length - 1)
                    if ($lastChar -ne ',' -and $lastChar -ne '{') { $needsComma = $true }
                }
                $comma = if ($needsComma) { ',' } else { '' }
                $inserted = $before + $comma + "`r`n    ""jetski.cloudCodeUrl"": """ + $DefaultProxyUrl + """`r`n}"
                [System.IO.File]::WriteAllText($SettingsPath, $inserted)
            }
        }
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $SettingsPath) | Out-Null
        $initJson = "{" + "`r`n    ""jetski.cloudCodeUrl"": """ + $DefaultProxyUrl + """`r`n}"
        Set-Content -Path $SettingsPath -Value $initJson -Encoding UTF8
    }
    Write-Host "  [OK] settings.json endpoint configured" -ForegroundColor Green

} else {
    Write-Host "Pausing Proxy (Switching to Pure Official Mode)..." -ForegroundColor Yellow

    # 3.1 Comment out injection in out/main.js
    if ($mainContent.Contains($BootstrapHeader)) {
        $mainContent = $mainContent.Replace($BootstrapHeader, "// $BootstrapHeader")
    }
    if ($mainContent.Contains($BootstrapImport)) {
        $mainContent = $mainContent.Replace($BootstrapImport, "// $BootstrapImport")
    }
    [System.IO.File]::WriteAllText($MainJs, $mainContent)
    Write-Host "  [OK] Main process proxy injection paused" -ForegroundColor Green

    # 3.2 Remove jetski.cloudCodeUrl from settings.json
    if (Test-Path $SettingsPath) {
        $lines = Get-Content $SettingsPath
        $newLines = @()
        foreach ($line in $lines) {
            if ($line -notmatch 'jetski\.cloudCodeUrl') {
                $newLines += $line
            }
        }
        $joined = ($newLines -join "`r`n") -replace ',(\s*})', '$1'
        [System.IO.File]::WriteAllText($SettingsPath, $joined)
        Write-Host "  [OK] Removed proxy endpoint from settings.json" -ForegroundColor Green
    }
}

# -- 4. Update product.json checksums
if (Test-Path $ProductJson) {
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        $prod = Get-Content $ProductJson -Raw | ConvertFrom-Json
        if ($prod.checksums) {
            $outDir = Join-Path $AppRoot 'out'
            $updatedCount = 0
            foreach ($prop in $prod.checksums.psobject.Properties) {
                $targetFile = Join-Path $outDir ($prop.Name.Replace('/', '\'))
                if (Test-Path $targetFile) {
                    $fBytes = [System.IO.File]::ReadAllBytes($targetFile)
                    $fHash = [System.Convert]::ToBase64String($sha256.ComputeHash($fBytes)).TrimEnd('=')
                    if ($prop.Value -ne $fHash) {
                        $prod.checksums.($prop.Name) = $fHash
                        $updatedCount++
                    }
                }
            }
            if ($updatedCount -gt 0) {
                $prod | ConvertTo-Json -Depth 10 | Set-Content -Path $ProductJson -Encoding UTF8
            }
        }
    } catch {
        # ignore checksum update error
    }
}

# -- 5. Restart IDE
if ($wasRunning -and (-not $NoRestart)) {
    Write-Host "Restarting Antigravity IDE..." -ForegroundColor Yellow
    $exePath = Join-Path $IdePath 'Antigravity IDE.exe'
    if (Test-Path $exePath) {
        Start-Process -FilePath $exePath
    }
}

Write-Host "============================================" -ForegroundColor Cyan
if ($targetEnable) {
    Write-Host " Proxy [ENABLED] successfully!" -ForegroundColor Green
    Write-Host " Custom models and dashboard are now active." -ForegroundColor Gray
} else {
    Write-Host " Proxy [PAUSED] successfully!" -ForegroundColor Yellow
    Write-Host " Antigravity IDE is now running in 100% official native mode." -ForegroundColor Gray
}
Write-Host "============================================" -ForegroundColor Cyan
