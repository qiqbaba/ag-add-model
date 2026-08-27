# =====================================================================
# antigravity-add-model — Antigravity IDE (VS Code Fork) 自动部署脚本
# 适用于解包式 resources\app 布局的 Antigravity IDE 独立版
# 用法: .\deploy-ide.ps1 [-IdePath "..."] [-SkipBuild] [-SkipBinaryPatch]
# =====================================================================
param(
    [string]$IdePath = "C:\Users\21855\AppData\Local\Programs\Antigravity IDE",
    [switch]$SkipBuild,
    [switch]$SkipBinaryPatch,
    [switch]$SkipLaunch
)

$ErrorActionPreference = "Stop"
$ProjectDir = $PSScriptRoot
$AppRoot = Join-Path $IdePath "resources\app"
$BackupDir = Join-Path $IdePath "resources\app_backup"
$ProxyDir = Join-Path $AppRoot "out\proxy"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " antigravity-add-model - Antigravity IDE Deploy" -ForegroundColor Yellow
Write-Host "============================================" -ForegroundColor Cyan

# ── 0. 环境检查 ─────────────────────────────────────────────
Write-Host "[0/8] 环境检查..." -ForegroundColor Yellow
if (-not (Test-Path (Join-Path $AppRoot "out\main.js"))) {
    throw "未找到 $($AppRoot)\out\main.js — 请确认 -IdePath 指向 Antigravity IDE 安装目录"
}
$pkg = Get-Content (Join-Path $AppRoot "package.json") -Raw | ConvertFrom-Json
Write-Host "   IDE: $($pkg.name) v$($pkg.version) (type=$($pkg.type))" -ForegroundColor Gray
if ($pkg.type -ne "module") { Write-Host "   警告: 主进程非 ESM, 注入方式可能需调整" -ForegroundColor DarkYellow }

# ── 1. 编译 ─────────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Host "[1/8] 编译 TypeScript..." -ForegroundColor Yellow
    Push-Location $ProjectDir
    npm run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "编译失败" }
    Pop-Location
} else {
    Write-Host "[1/8] 跳过编译 (-SkipBuild)" -ForegroundColor DarkYellow
}
if (-not (Test-Path (Join-Path $ProjectDir "dist\proxy.js"))) { throw "dist\proxy.js 不存在, 请先编译" }

# ── 2. 终止进程 ─────────────────────────────────────────────
Write-Host "[2/8] 终止 Antigravity 进程..." -ForegroundColor Yellow
Stop-Process -Name "Antigravity IDE" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "language_server_windows_x64" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# ── 3. 备份 ─────────────────────────────────────────────────
Write-Host "[3/8] 备份原版文件..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$targets = @(
    @{ src = "$AppRoot\out\main.js"; bak = "$BackupDir\main.js.bak" },
    @{ src = "$AppRoot\out\vs\workbench\workbench.desktop.main.js"; bak = "$BackupDir\workbench.desktop.main.js.bak" },
    @{ src = "$AppRoot\extensions\antigravity\bin\language_server_windows_x64.exe"; bak = "$BackupDir\language_server_windows_x64.exe.bak" }
)
foreach ($t in $targets) {
    if (-not (Test-Path $t.bak)) { Copy-Item $t.src $t.bak -Force; Write-Host "   备份: $(Split-Path $t.bak -Leaf)" -ForegroundColor Gray }
    else { Write-Host "   已存在: $(Split-Path $t.bak -Leaf)" -ForegroundColor DarkGray }
}

# 生成回滚脚本
$rollback = @"
# antigravity-add-model 一键回滚
`$ErrorActionPreference = "Stop"
`$AppRoot = "$AppRoot"
`$BakRoot = "$BackupDir"
Stop-Process -Name "Antigravity IDE" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "language_server_windows_x64" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Copy-Item "`$BakRoot\main.js.bak" "`$AppRoot\out\main.js" -Force
Copy-Item "`$BakRoot\workbench.desktop.main.js.bak" "`$AppRoot\out\vs\workbench\workbench.desktop.main.js" -Force
Copy-Item "`$BakRoot\language_server_windows_x64.exe.bak" "`$AppRoot\extensions\antigravity\bin\language_server_windows_x64.exe" -Force
if (Test-Path "`$AppRoot\out\proxy") { Remove-Item "`$AppRoot\out\proxy" -Recurse -Force }
Write-Host "回滚完成。请手动删除 settings.json 中的 jetski.cloudCodeUrl 条目。" -ForegroundColor Green
"@
Set-Content -Path (Join-Path $BackupDir "rollback.ps1") -Value $rollback -Encoding UTF8

# ── 4. 部署代理模块 ─────────────────────────────────────────
Write-Host "[4/8] 部署代理模块到 out\proxy ..." -ForegroundColor Yellow
if (Test-Path $ProxyDir) { Remove-Item $ProxyDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ProxyDir | Out-Null
foreach ($f in @("index.js", "proxy.js", "cryptoStore.js", "schemaValidator.js", "types.js")) {
    $srcPath = Join-Path $ProjectDir "dist\$f"
    if (Test-Path $srcPath) {
        Copy-Item $srcPath $ProxyDir -Force
    }
}
Copy-Item (Join-Path $ProjectDir "dist\proxy") "$ProxyDir\proxy" -Recurse -Force
Set-Content -Path (Join-Path $ProxyDir "package.json") -Value '{"name":"antigravity-proxy-host","version":"1.0.0","private":true,"main":"bootstrap.js"}'
Push-Location $ProxyDir
npm install electron-log@^5 --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "electron-log 安装失败" }
Pop-Location

# 关键修复: 响应改写时移除 transfer-encoding (与 content-length 互斥)
$proxyJs = Join-Path $ProxyDir "proxy.js"
$pt = [System.IO.File]::ReadAllText($proxyJs)
if (-not $pt.Contains("delete modifiedHeaders['transfer-encoding'];")) {
    $pt = $pt.Replace("delete modifiedHeaders['content-encoding'];", "delete modifiedHeaders['content-encoding'];`n                delete modifiedHeaders['transfer-encoding'];")
    [System.IO.File]::WriteAllText($proxyJs, $pt)
    Write-Host "   已应用 transfer-encoding 修复补丁" -ForegroundColor Green
}

# bootstrap.js
$bootstrap = @'
"use strict";
(function () {
  try {
    var electron = require("electron");
    var path = require("path");
    var fs = require("fs");
    var os = require("os");
    var start = function () {
      try {
        var proxy = require("./proxy");
        proxy.startProxy().then(function (port) {
          try {
            var dir = path.join(os.homedir(), ".gemini", "antigravity");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "active_port"), String(port));
          } catch (e) { console.error("[agy-proxy] active_port:", e); }
          electron.app.on("will-quit", function () {
            try { proxy.stopProxy(); } catch (e) { /* ignore */ }
          });
        }).catch(function (e) { console.error("[agy-proxy] startProxy:", e); });
      } catch (e) { console.error("[agy-proxy] init:", e); }
    };
    if (electron.app && electron.app.isReady && electron.app.isReady()) setTimeout(start, 0);
    else if (electron.app) electron.app.whenReady().then(start);
  } catch (e) { try { console.error("[agy-proxy] bootstrap:", e); } catch (_e) {} }
})();
'@
Set-Content -Path (Join-Path $ProxyDir "bootstrap.js") -Value $bootstrap -Encoding UTF8

# ── 5. 注入主进程 (ESM 安全) ────────────────────────────────
Write-Host "[5/8] 注入 out\main.js ..." -ForegroundColor Yellow
$mainJs = Join-Path $AppRoot "out\main.js"
$mt = [System.IO.File]::ReadAllText($mainJs)
if ($mt.Contains("/* antigravity-add-model bootstrap */")) {
    Write-Host "   已注入, 跳过" -ForegroundColor DarkGray
} else {
    $inj = "/* antigravity-add-model bootstrap */`r`nimport('./proxy/bootstrap.js').catch(function(e){console.error('[agy-proxy] import failed',e);});`r`n"
    [System.IO.File]::WriteAllText($mainJs, $inj + $mt)
    Write-Host "   注入完成 (ESM dynamic import)" -ForegroundColor Green
}

# ── 6. 写入 jetski.cloudCodeUrl 设置 ────────────────────────
Write-Host "[6/8] 写入 jetski.cloudCodeUrl 设置..." -ForegroundColor Yellow
$proxyUrl = "http://127.0.0.1:50999/v1internal/xxxxxxx"
$settingsPath = Join-Path $env:APPDATA "Antigravity IDE\User\settings.json"
New-Item -ItemType Directory -Force -Path (Split-Path $settingsPath) | Out-Null
if (-not (Test-Path $settingsPath)) { Set-Content -Path $settingsPath -Value "{}" }
$st = [System.IO.File]::ReadAllText($settingsPath)
if ($st.Contains("jetski.cloudCodeUrl")) {
    Write-Host "   已存在, 跳过" -ForegroundColor DarkGray
} else {
    $st = $st.TrimEnd()
    if ($st.EndsWith("}")) {
        $trimmed = $st.Substring(0, $st.Length - 1).TrimEnd()
        if ($trimmed.Length -gt 1) { $st = $trimmed + "," + "`r`n    `"jetski.cloudCodeUrl`": `"$proxyUrl`"`r`n}" }
        else { $st = "{`r`n    `"jetski.cloudCodeUrl`": `"$proxyUrl`"`r`n}" }
    }
    [System.IO.File]::WriteAllText($settingsPath, $st)
    Write-Host "   已写入: $proxyUrl" -ForegroundColor Green
}

# ── 7. LS 二进制补丁 (可选) ─────────────────────────────────
if (-not $SkipBinaryPatch) {
    Write-Host "[7/8] LS 二进制补丁 (可选, 此架构下非必需)..." -ForegroundColor Yellow
    $ls = Join-Path $AppRoot "extensions\antigravity\bin\language_server_windows_x64.exe"
    $orig = [System.Text.Encoding]::ASCII.GetBytes("https://daily-cloudcode-pa.googleapis.com")
    $repl = [System.Text.Encoding]::ASCII.GetBytes($proxyUrl)
    $bytes = [System.IO.File]::ReadAllBytes($ls)
    $found = 0
    for ($i = 0; $i -le $bytes.Length - $orig.Length; $i++) {
        if ($bytes[$i] -ne $orig[0]) { continue }
        $ok = $true
        for ($j = 1; $j -lt $orig.Length; $j++) { if ($bytes[$i + $j] -ne $orig[$j]) { $ok = $false; break } }
        if ($ok) { [Array]::Copy($repl, 0, $bytes, $i, $repl.Length); $found++ }
    }
    if ($found -gt 0) { [System.IO.File]::WriteAllBytes($ls, $bytes); Write-Host "   替换 $($found) 处" -ForegroundColor Green }
    else { Write-Host "   未找到目标 URL (可能已打补丁), 跳过" -ForegroundColor DarkGray }
} else {
    Write-Host "[7/8] 跳过二进制补丁 (-SkipBinaryPatch)" -ForegroundColor DarkYellow
}

# ── 8. 初始化配置并启动 ─────────────────────────────────────
Write-Host "[8/8] 初始化 custom_models.json 并启动..." -ForegroundColor Yellow
$agyDir = Join-Path $env:USERPROFILE ".gemini\antigravity"
New-Item -ItemType Directory -Force -Path $agyDir | Out-Null
$cmj = Join-Path $agyDir "custom_models.json"
if (-not (Test-Path $cmj)) {
    Set-Content -Path $cmj -Value '{ "models": [] }' -Encoding UTF8
    Write-Host "   已创建空配置: $cmj" -ForegroundColor Green
} else {
    Write-Host "   配置已存在: $cmj" -ForegroundColor DarkGray
}

if (-not $SkipLaunch) {
    Start-Process -FilePath (Join-Path $IdePath "Antigravity IDE.exe")
    Start-Sleep -Seconds 15
    $port = Join-Path $agyDir "active_port"
    if (Test-Path $port) {
        $p = Get-Content $port
        try {
            $health = Invoke-WebRequest -Uri "http://127.0.0.1:$p/health" -UseBasicParsing -TimeoutSec 5
            Write-Host ""
            Write-Host "============================================" -ForegroundColor Cyan
            Write-Host " 部署成功! 代理运行于 http://127.0.0.1:$p" -ForegroundColor Green
            Write-Host " 健康检查: $($health.StatusCode)" -ForegroundColor Green
            Write-Host "============================================" -ForegroundColor Cyan
        } catch { Write-Host "代理健康检查失败, 请查看日志" -ForegroundColor Red }
    } else { Write-Host "active_port 未生成, 请查看日志排查" -ForegroundColor Red }
}
Write-Host ""
Write-Host "日志: %APPDATA%\Antigravity IDE\logs\main.log" -ForegroundColor Gray
Write-Host "回滚: $BackupDir\rollback.ps1" -ForegroundColor Gray
