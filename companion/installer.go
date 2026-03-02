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
		"darwin/amd64":  "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-darwin-amd64",
		"darwin/arm64":  "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-darwin-arm64",
		"linux/amd64":   "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-linux-amd64",
		"linux/arm64":   "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-linux-arm64",
		"windows/amd64": "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-windows-amd64.exe",
	},
}

// WhisperfileURL points to the cross-platform whisperfile with a baked-in model (~87 MB).
var WhisperfileURL = "https://huggingface.co/Mozilla/whisperfile/resolve/main/whisper-tiny.en.llamafile"

// LlamafileURLs for the bundled model
var LlamafileURLs = map[string]string{
	// Phi-3 Mini Q4 llamafile — single executable with model baked in (~2.4GB)
	"llamafile": "https://huggingface.co/Mozilla/Phi-3-mini-4k-instruct-llamafile/resolve/main/Phi-3-mini-4k-instruct.Q4_K_M.llamafile",
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

// InstallWhisperfile fetches the whisperfile binary (model + runtime in one file) into dataDir/bin.
func InstallWhisperfile(dataDir string) error {
	binDir := filepath.Join(dataDir, "bin")
	if err := os.MkdirAll(binDir, 0755); err != nil {
		return fmt.Errorf("cannot create bin directory: %w", err)
	}

	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	destPath := filepath.Join(binDir, "whisperfile"+ext)

	if _, err := os.Stat(destPath); err == nil {
		log.Printf("Whisperfile already exists at %s", destPath)
		return nil
	}

	log.Printf("Downloading whisperfile (~87MB) from %s...", WhisperfileURL)
	if err := downloadFile(WhisperfileURL, destPath); err != nil {
		return fmt.Errorf("download failed: %w", err)
	}

	if runtime.GOOS != "windows" {
		if err := os.Chmod(destPath, 0755); err != nil {
			return fmt.Errorf("chmod failed: %w", err)
		}
	}

	log.Printf("Installed whisperfile to %s", destPath)
	return nil
}

// InstallLlamafile fetches the llamafile binary (model + runtime) into dataDir/bin.
func InstallLlamafile(dataDir string) error {
	url := LlamafileURLs["llamafile"]

	binDir := filepath.Join(dataDir, "bin")
	if err := os.MkdirAll(binDir, 0755); err != nil {
		return fmt.Errorf("cannot create bin directory: %w", err)
	}

	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	destPath := filepath.Join(binDir, "llamafile"+ext)

	if _, err := os.Stat(destPath); err == nil {
		log.Printf("Llamafile already exists at %s", destPath)
		return nil
	}

	log.Printf("Downloading llamafile (~2.4GB) from %s...", url)
	if err := downloadFile(url, destPath); err != nil {
		return fmt.Errorf("download failed: %w", err)
	}

	if runtime.GOOS != "windows" {
		if err := os.Chmod(destPath, 0755); err != nil {
			return fmt.Errorf("chmod failed: %w", err)
		}
	}

	log.Printf("Installed llamafile to %s", destPath)
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
