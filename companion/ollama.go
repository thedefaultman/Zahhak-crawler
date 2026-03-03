package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	ollamaAPI       = "http://localhost:11434"
	ollamaSetupURL  = "https://ollama.com/download/OllamaSetup.exe"
	ollamaStartWait = 15 * time.Second
)

// OllamaStatus holds the current state of the Ollama service.
type OllamaStatus struct {
	Installed   bool   `json:"installed"`
	Running     bool   `json:"running"`
	ModelPulled bool   `json:"modelPulled"`
	ModelName   string `json:"modelName"`
	Pulling     bool   `json:"pulling"`
	PullPct     int    `json:"pullPct,omitempty"`
}

var ollamaState = OllamaStatus{}

// ollamaExePath returns the path to the ollama binary, checking known install
// locations since the current process may not have an updated PATH.
func ollamaExePath() string {
	// Check PATH first
	if p, err := exec.LookPath("ollama"); err == nil {
		return p
	}

	// Known Windows install location (OllamaSetup.exe installs here)
	home, _ := os.UserHomeDir()
	if home != "" {
		candidate := filepath.Join(home, "AppData", "Local", "Programs", "Ollama", "ollama.exe")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}

	// Also check Program Files
	for _, envVar := range []string{"PROGRAMFILES", "LOCALAPPDATA"} {
		dir := os.Getenv(envVar)
		if dir != "" {
			candidate := filepath.Join(dir, "Ollama", "ollama.exe")
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}

	return ""
}

// IsOllamaInstalled checks if the ollama binary exists.
func IsOllamaInstalled() bool {
	return ollamaExePath() != ""
}

// InstallOllama downloads and runs OllamaSetup.exe silently.
func InstallOllama(dataDir string) error {
	if IsOllamaInstalled() {
		log.Println("[Ollama] Already installed")
		return nil
	}

	setupPath := filepath.Join(dataDir, "OllamaSetup.exe")

	log.Println("[Ollama] Downloading installer...")
	if err := downloadFile(ollamaSetupURL, setupPath); err != nil {
		return fmt.Errorf("failed to download Ollama installer: %w", err)
	}

	log.Println("[Ollama] Running installer (silent)...")
	cmd := exec.Command(setupPath, "/S")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("Ollama installer failed: %w", err)
	}

	// Clean up installer
	os.Remove(setupPath)

	// Wait for ollama to be available (check known paths, not just PATH)
	for i := 0; i < 10; i++ {
		if IsOllamaInstalled() {
			log.Printf("[Ollama] Installed successfully at %s", ollamaExePath())
			return nil
		}
		time.Sleep(1 * time.Second)
	}

	return fmt.Errorf("ollama not found after installation")
}

// IsOllamaServing checks if the Ollama API is responding.
func IsOllamaServing() bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(ollamaAPI + "/api/tags")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

// EnsureOllamaServing starts Ollama if it's not already running.
func EnsureOllamaServing() error {
	if IsOllamaServing() {
		return nil
	}

	ollamaPath := ollamaExePath()
	if ollamaPath == "" {
		return fmt.Errorf("ollama binary not found")
	}

	log.Printf("[Ollama] Starting Ollama serve (%s)...", ollamaPath)
	cmd := exec.Command(ollamaPath, "serve")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start ollama serve: %w", err)
	}

	// Don't wait on the process — it runs as a background server
	go cmd.Wait()

	// Poll until serving
	deadline := time.Now().Add(ollamaStartWait)
	for time.Now().Before(deadline) {
		if IsOllamaServing() {
			log.Println("[Ollama] Server is ready")
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}

	return fmt.Errorf("ollama did not start within %s", ollamaStartWait)
}

// ollamaTagsResponse models the JSON from GET /api/tags
type ollamaTagsResponse struct {
	Models []struct {
		Name string `json:"name"`
	} `json:"models"`
}

// IsModelPulled checks if a specific model is already available locally.
func IsModelPulled(model string) bool {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(ollamaAPI + "/api/tags")
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	var tags ollamaTagsResponse
	if err := json.NewDecoder(resp.Body).Decode(&tags); err != nil {
		return false
	}

	for _, m := range tags.Models {
		if m.Name == model || strings.HasPrefix(m.Name, model) {
			return true
		}
	}
	return false
}

// PullModel pulls a model from the Ollama registry.
func PullModel(model string) error {
	if IsModelPulled(model) {
		log.Printf("[Ollama] Model %s is already available", model)
		return nil
	}

	ollamaState.Pulling = true
	ollamaState.PullPct = 0
	defer func() {
		ollamaState.Pulling = false
		ollamaState.PullPct = 0
	}()

	log.Printf("[Ollama] Pulling model %s...", model)

	body := fmt.Sprintf(`{"name":"%s","stream":true}`, model)
	resp, err := http.Post(ollamaAPI+"/api/pull", "application/json", strings.NewReader(body))
	if err != nil {
		return fmt.Errorf("pull request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("pull failed: HTTP %d — %s", resp.StatusCode, string(respBody))
	}

	// Stream progress
	decoder := json.NewDecoder(resp.Body)
	for decoder.More() {
		var progress struct {
			Status    string `json:"status"`
			Total     int64  `json:"total"`
			Completed int64  `json:"completed"`
		}
		if err := decoder.Decode(&progress); err != nil {
			break
		}
		if progress.Total > 0 {
			pct := int(progress.Completed * 100 / progress.Total)
			ollamaState.PullPct = pct
			if pct%10 == 0 {
				log.Printf("[Ollama] Pull progress: %d%% (%s)", pct, progress.Status)
			}
		}
	}

	if !IsModelPulled(model) {
		return fmt.Errorf("model %s not found after pull", model)
	}

	log.Printf("[Ollama] Model %s is ready", model)
	ollamaState.ModelPulled = true
	ollamaState.ModelName = model
	return nil
}

// GetOllamaStatus returns the current Ollama status for the /health endpoint.
func GetOllamaStatus() OllamaStatus {
	return OllamaStatus{
		Installed:   IsOllamaInstalled(),
		Running:     IsOllamaServing(),
		ModelPulled: ollamaState.ModelPulled,
		ModelName:   ollamaState.ModelName,
		Pulling:     ollamaState.Pulling,
		PullPct:     ollamaState.PullPct,
	}
}
