# BYOK AI Chat - Build script for Chrome Web Store submission
# Creates a clean .zip package containing only the files needed for the extension.

param(
    [string]$OutputDir = "build",
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"

# Read version from manifest.json if not provided
if (-not $Version) {
    $manifest = Get-Content -Path (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
    $Version = $manifest.version
}

$packageName = "byok-ai-chat-v$Version-$timestamp"
$packagePath = Join-Path $root $OutputDir

# Clean and recreate build directory
if (Test-Path $packagePath) {
    Remove-Item -Path $packagePath -Recurse -Force
}
New-Item -ItemType Directory -Path $packagePath -Force | Out-Null

Write-Host "Building $packageName..." -ForegroundColor Cyan

# Files and folders to include
$include = @(
    "manifest.json",
    "background.js",
    "sidepanel.html",
    "content.js",
    "icons",
    "css",
    "js",
    "lib"
)

# Files and folders to exclude
$exclude = @(
    ".git",
    ".github",
    ".gitignore",
    ".gitattributes",
    "build",
    "node_modules",
    "*.md",
    "*.ps1",
    "*.zip",
    "*.log",
    "LICENSE",
    "PRIVACY.md"
)

foreach ($item in $include) {
    $sourcePath = Join-Path $root $item
    if (Test-Path $sourcePath) {
        $destPath = Join-Path $packagePath $item
        Copy-Item -Path $sourcePath -Destination $destPath -Recurse -Force
        Write-Host "  + $item" -ForegroundColor Green
    } else {
        Write-Host "  ! $item (not found, skipping)" -ForegroundColor Yellow
    }
}

# Create the zip
$zipPath = Join-Path $root "$packageName.zip"
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($packagePath, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)

Write-Host ""
Write-Host "Package created: $zipPath" -ForegroundColor Cyan
Write-Host "Size: $([math]::Round((Get-Item $zipPath).Length / 1KB, 2)) KB" -ForegroundColor Cyan
Write-Host ""
Write-Host "Upload this file to: https://chrome.google.com/webstore/devconsole" -ForegroundColor Yellow
