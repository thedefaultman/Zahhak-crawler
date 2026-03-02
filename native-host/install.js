#!/usr/bin/env node

// ===== Native Messaging Host Installer =====
// Registers the native messaging host with Chrome/Chromium browsers.
// Run: node install.js [--extension-id=YOUR_EXTENSION_ID]

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOST_NAME = 'com.browsing_capture.host';
const HOST_DESCRIPTION = 'Browsing Capture native messaging host for writing markdown files and exporting JSONL training data';

// Parse args
const args = process.argv.slice(2);
let extensionId = null;
let uninstall = false;

for (const arg of args) {
  if (arg.startsWith('--extension-id=')) {
    extensionId = arg.split('=')[1];
  }
  if (arg === '--uninstall') {
    uninstall = true;
  }
  if (arg === '--help' || arg === '-h') {
    console.log(`
Browsing Capture — Native Host Installer

Usage:
  node install.js --extension-id=<your-chrome-extension-id>
  node install.js --uninstall

Options:
  --extension-id=ID   Your Chrome extension ID (find it in chrome://extensions)
  --uninstall         Remove the native messaging host registration
  --help, -h          Show this help message

After installing, restart Chrome for changes to take effect.
    `);
    process.exit(0);
  }
}

if (!uninstall && !extensionId) {
  console.error('Error: --extension-id is required for installation.');
  console.error('Find your extension ID at chrome://extensions (enable Developer mode)');
  console.error('Usage: node install.js --extension-id=abcdefghijklmnopqrstuvwxyz');
  process.exit(1);
}

// ===== Determine OS-specific paths =====
function getNativeMessagingDir() {
  const platform = os.platform();
  const home = os.homedir();

  switch (platform) {
    case 'win32':
      // On Windows, we use the registry, but also place the manifest
      return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts');

    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');

    case 'linux':
      return path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts');

    default:
      console.error(`Unsupported platform: ${platform}`);
      process.exit(1);
  }
}

// Also support Chromium and Edge
function getAllBrowserDirs() {
  const platform = os.platform();
  const home = os.homedir();
  const dirs = [];

  if (platform === 'win32') {
    dirs.push(path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'));
    dirs.push(path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'NativeMessagingHosts'));
    dirs.push(path.join(home, 'AppData', 'Local', 'Chromium', 'User Data', 'NativeMessagingHosts'));
  } else if (platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'));
    dirs.push(path.join(home, 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'));
    dirs.push(path.join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'));
  } else {
    dirs.push(path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'));
    dirs.push(path.join(home, '.config', 'microsoft-edge', 'NativeMessagingHosts'));
    dirs.push(path.join(home, '.config', 'chromium', 'NativeMessagingHosts'));
  }

  return dirs;
}

// ===== Install =====
function install() {
  const hostPath = path.resolve(__dirname, 'host.js');
  const nodePath = process.execPath;

  // Create the native messaging host manifest
  const manifest = {
    name: HOST_NAME,
    description: HOST_DESCRIPTION,
    path: hostPath,
    type: 'stdio',
    allowed_origins: [
      `chrome-extension://${extensionId}/`,
    ],
  };

  // For Windows, we need a batch wrapper
  if (os.platform() === 'win32') {
    const batPath = path.resolve(__dirname, 'host.bat');
    const batContent = `@echo off\n"${nodePath}" "${hostPath}"`;
    fs.writeFileSync(batPath, batContent);
    manifest.path = batPath;
  }

  const manifestJson = JSON.stringify(manifest, null, 2);

  // Install to all detected browser dirs
  const dirs = getAllBrowserDirs();
  let installed = 0;

  for (const dir of dirs) {
    try {
      // Check if the parent directory exists (browser is installed)
      const parentDir = path.dirname(dir);
      if (!fs.existsSync(parentDir)) continue;

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const manifestPath = path.join(dir, `${HOST_NAME}.json`);
      fs.writeFileSync(manifestPath, manifestJson);
      console.log(`  Installed: ${manifestPath}`);
      installed++;
    } catch (err) {
      console.warn(`  Skipped ${dir}: ${err.message}`);
    }
  }

  // On Windows, also set registry key
  if (os.platform() === 'win32') {
    try {
      const { execSync } = require('child_process');
      const manifestPath = path.join(getNativeMessagingDir(), `${HOST_NAME}.json`);
      execSync(`reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'pipe' });
      console.log('  Windows registry key set for Chrome');
    } catch (err) {
      console.warn('  Could not set Windows registry key:', err.message);
    }
  }

  if (installed === 0) {
    console.error('\nNo supported browsers found! Make sure Chrome, Edge, or Chromium is installed.');
    process.exit(1);
  }

  // Create default output directory
  const defaultDir = path.join(os.homedir(), 'BrowsingCapture', 'captures');
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
    console.log(`\n  Created output directory: ${defaultDir}`);
  }

  console.log(`\nInstallation complete! Installed to ${installed} browser(s).`);
  console.log('Restart your browser for changes to take effect.');
  console.log(`\nCaptures will be saved to: ${path.join(os.homedir(), 'BrowsingCapture')}`);
}

// ===== Uninstall =====
function uninstallHost() {
  const dirs = getAllBrowserDirs();
  let removed = 0;

  for (const dir of dirs) {
    const manifestPath = path.join(dir, `${HOST_NAME}.json`);
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath);
      console.log(`  Removed: ${manifestPath}`);
      removed++;
    }
  }

  // Remove Windows registry key
  if (os.platform() === 'win32') {
    try {
      const { execSync } = require('child_process');
      execSync(`reg delete "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" /f`, { stdio: 'pipe' });
      console.log('  Removed Windows registry key');
    } catch (err) { /* key may not exist */ }
  }

  // Remove batch file on Windows
  const batPath = path.resolve(__dirname, 'host.bat');
  if (fs.existsSync(batPath)) {
    fs.unlinkSync(batPath);
  }

  console.log(`\nUninstallation complete! Removed from ${removed} browser(s).`);
  console.log('Restart your browser for changes to take effect.');
}

// ===== Run =====
console.log(`\nBrowsing Capture — Native Host ${uninstall ? 'Uninstaller' : 'Installer'}`);
console.log('='.repeat(50));

if (uninstall) {
  uninstallHost();
} else {
  install();
}
