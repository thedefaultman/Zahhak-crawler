package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
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
