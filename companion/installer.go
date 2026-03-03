package main

import (
	"archive/zip"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// DownloadURLs contains per-platform binary download URLs keyed by service name.
var DownloadURLs = map[string]map[string]string{
	"pinchtab": {
		"windows/amd64": "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-windows-amd64.exe",
	},
}

// InstallService downloads the named service binary for the current platform into dataDir/bin.
func InstallService(name string, dataDir string) error {
	platform := runtime.GOOS + "/" + runtime.GOARCH

	urls, ok := DownloadURLs[name]
	if !ok {
		return fmt.Errorf("unknown service: %s", name)
	}

	url, ok := urls[platform]
	if !ok {
		return fmt.Errorf("no binary available for %s on %s", name, platform)
	}

	binDir := filepath.Join(dataDir, "bin")
	if err := os.MkdirAll(binDir, 0755); err != nil {
		return fmt.Errorf("cannot create bin directory: %w", err)
	}

	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	destPath := filepath.Join(binDir, name+ext)

	log.Printf("Downloading %s from %s...", name, url)
	if err := downloadFile(url, destPath); err != nil {
		return fmt.Errorf("download failed: %w", err)
	}

	if runtime.GOOS != "windows" {
		if err := os.Chmod(destPath, 0755); err != nil {
			return fmt.Errorf("chmod failed: %w", err)
		}
	}

	log.Printf("Installed %s to %s", name, destPath)
	return nil
}

// progressWriter wraps an io.Writer and prints download progress
type progressWriter struct {
	dest      io.Writer
	total     int64
	written   int64
	lastPct   int
	startTime int64
}

func (pw *progressWriter) Write(p []byte) (int, error) {
	n, err := pw.dest.Write(p)
	pw.written += int64(n)

	if pw.total > 0 {
		pct := int(pw.written * 100 / pw.total)
		if pct != pw.lastPct && pct%5 == 0 {
			pw.lastPct = pct
			mb := float64(pw.written) / 1024 / 1024
			totalMB := float64(pw.total) / 1024 / 1024
			fmt.Printf("  Downloading... %.1f / %.1f MB (%d%%)\n", mb, totalMB, pct)
		}
	}
	return n, err
}

func downloadFile(url string, destPath string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
	}

	tmpPath := destPath + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		return err
	}
	defer out.Close()

	pw := &progressWriter{
		dest:  out,
		total: resp.ContentLength,
	}

	_, err = io.Copy(pw, resp.Body)
	if err != nil {
		os.Remove(tmpPath)
		return err
	}

	out.Close()
	return os.Rename(tmpPath, destPath)
}

// ExtensionDownloadURL is the URL for the Zahhak extension zip (platform-independent).
var ExtensionDownloadURL = "https://github.com/thedefaultman/Zahhak-crawler/releases/latest/download/zahhak-extension.zip"

// InstallExtension downloads and extracts the Zahhak Chrome extension.
func InstallExtension(dataDir string) error {
	extDir := filepath.Join(dataDir, "extension")
	manifestPath := filepath.Join(extDir, "manifest.json")

	// Skip if already installed
	if _, err := os.Stat(manifestPath); err == nil {
		log.Println("[Extension] Already installed")
		return nil
	}

	zipPath := filepath.Join(dataDir, "extension.zip")

	log.Printf("[Extension] Downloading from %s...", ExtensionDownloadURL)
	if err := downloadFile(ExtensionDownloadURL, zipPath); err != nil {
		return fmt.Errorf("failed to download extension: %w", err)
	}

	log.Println("[Extension] Extracting...")
	if err := os.MkdirAll(extDir, 0755); err != nil {
		return fmt.Errorf("cannot create extension directory: %w", err)
	}

	if err := extractZip(zipPath, extDir); err != nil {
		return fmt.Errorf("failed to extract extension: %w", err)
	}

	// Clean up zip
	os.Remove(zipPath)

	// Verify manifest exists after extraction
	if _, err := os.Stat(manifestPath); os.IsNotExist(err) {
		return fmt.Errorf("extension extraction succeeded but manifest.json not found")
	}

	log.Printf("[Extension] Installed to %s", extDir)
	return nil
}

// extractZip extracts a zip archive to the destination directory.
func extractZip(zipPath string, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		// Sanitize path to prevent zip slip attacks
		name := filepath.FromSlash(f.Name)
		if strings.Contains(name, "..") {
			continue
		}

		target := filepath.Join(destDir, name)

		if f.FileInfo().IsDir() {
			os.MkdirAll(target, 0755)
			continue
		}

		// Ensure parent directory exists
		os.MkdirAll(filepath.Dir(target), 0755)

		outFile, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			return err
		}

		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			return err
		}

		_, err = io.Copy(outFile, rc)
		rc.Close()
		outFile.Close()
		if err != nil {
			return err
		}
	}

	return nil
}
