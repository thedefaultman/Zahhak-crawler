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

// DownloadURLs maps platform-specific download URLs for each service
var DownloadURLs = map[string]map[string]string{
	"pinchtab": {
		"darwin/amd64":  "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-darwin-amd64",
		"darwin/arm64":  "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-darwin-arm64",
		"linux/amd64":   "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-linux-amd64",
		"linux/arm64":   "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-linux-arm64",
		"windows/amd64": "https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-windows-amd64.exe",
	},
	"whisper-server": {
		// whisper.cpp server binaries — user may need to compile or use pre-built
		"darwin/amd64":  "https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-server-darwin-amd64",
		"darwin/arm64":  "https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-server-darwin-arm64",
		"linux/amd64":   "https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-server-linux-amd64",
		"windows/amd64": "https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-server-windows-amd64.exe",
	},
}

// ModelURLs maps model files to download
var ModelURLs = map[string]string{
	"ggml-tiny.en.bin": "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
}

// LlamafileURLs for the bundled model
var LlamafileURLs = map[string]string{
	// Phi-3 Mini Q4 llamafile — single executable with model baked in
	"llamafile": "https://huggingface.co/Mozilla/Phi-3-mini-4k-instruct-llamafile/resolve/main/Phi-3-mini-4k-instruct-Q4_K_M.llamafile",
}

// InstallService downloads and installs a service binary
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

	// Make executable on Unix
	if runtime.GOOS != "windows" {
		if err := os.Chmod(destPath, 0755); err != nil {
			return fmt.Errorf("chmod failed: %w", err)
		}
	}

	log.Printf("Installed %s to %s", name, destPath)
	return nil
}

// InstallModel downloads a model file
func InstallModel(name string, dataDir string) error {
	url, ok := ModelURLs[name]
	if !ok {
		return fmt.Errorf("unknown model: %s", name)
	}

	modelDir := filepath.Join(dataDir, "models")
	if err := os.MkdirAll(modelDir, 0755); err != nil {
		return fmt.Errorf("cannot create models directory: %w", err)
	}

	destPath := filepath.Join(modelDir, name)
	if _, err := os.Stat(destPath); err == nil {
		log.Printf("Model %s already exists at %s", name, destPath)
		return nil
	}

	log.Printf("Downloading model %s from %s...", name, url)
	return downloadFile(url, destPath)
}

// InstallLlamafile downloads the llamafile (model + runtime)
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

	log.Printf("Downloading llamafile (~2.2GB) from %s...", url)
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
