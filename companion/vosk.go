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
	"runtime"
	"strings"
	"time"
)

const (
	voskModelURL  = "https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip"
	voskModelName = "vosk-model-small-en-us-0.15"
)

// VoskStatus holds the current state of the Vosk STT service.
type VoskStatus struct {
	Installed    bool   `json:"installed"`
	Running      bool   `json:"running"`
	ModelPath    string `json:"modelPath,omitempty"`
	PythonFound  bool   `json:"pythonFound"`
	VoskPkgReady bool   `json:"voskPkgReady"`
	Error        string `json:"error,omitempty"`
}

var voskState = VoskStatus{}

// VoskModelDir returns the directory where Vosk models are stored.
func VoskModelDir(dataDir string) string {
	return filepath.Join(dataDir, "models", "vosk")
}

// VoskModelPath returns the path to the default Vosk model directory.
func VoskModelPath(dataDir string) string {
	return filepath.Join(VoskModelDir(dataDir), voskModelName)
}

// IsVoskModelInstalled checks if the Vosk model directory exists and has content.
func IsVoskModelInstalled(dataDir string) bool {
	modelPath := VoskModelPath(dataDir)
	info, err := os.Stat(modelPath)
	if err != nil {
		return false
	}
	return info.IsDir()
}

// findPython returns the first working Python command, or "" if none found.
func findPython() string {
	for _, pyCmd := range []string{"python", "python3", "py"} {
		cmd := exec.Command(pyCmd, "--version")
		if err := cmd.Run(); err == nil {
			return pyCmd
		}
	}
	return ""
}

// isVoskPkgInstalled checks if the Python vosk package is importable.
func isVoskPkgInstalled(pythonCmd string) bool {
	if pythonCmd == "" {
		return false
	}
	cmd := exec.Command(pythonCmd, "-c", "import vosk")
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run() == nil
}

// installVoskPkg installs the vosk Python package via pip.
func installVoskPkg(pythonCmd string) error {
	log.Println("[Vosk] Installing vosk Python package...")
	cmd := exec.Command(pythonCmd, "-m", "pip", "install", "vosk", "--quiet")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("pip install vosk failed: %w", err)
	}
	log.Println("[Vosk] Python vosk package installed successfully")
	return nil
}

// EnsureVoskReady installs the Vosk model and Python package if needed.
func EnsureVoskReady(dataDir string) error {
	// Step 1: Download and extract the Vosk model
	if err := InstallVoskModel(dataDir); err != nil {
		return err
	}

	// Step 2: Find Python
	pyCmd := findPython()
	if pyCmd == "" {
		return fmt.Errorf("Python not found. Install Python from https://python.org and ensure it's in PATH")
	}
	voskState.PythonFound = true
	log.Printf("[Vosk] Using Python: %s", pyCmd)

	// Step 3: Auto-install vosk package if missing
	if !isVoskPkgInstalled(pyCmd) {
		if err := installVoskPkg(pyCmd); err != nil {
			return fmt.Errorf("failed to install vosk package: %w", err)
		}
	}
	voskState.VoskPkgReady = true

	return nil
}

// InstallVoskModel downloads and extracts the Vosk model.
func InstallVoskModel(dataDir string) error {
	if IsVoskModelInstalled(dataDir) {
		log.Println("[Vosk] Model already installed")
		return nil
	}

	modelDir := VoskModelDir(dataDir)
	if err := os.MkdirAll(modelDir, 0755); err != nil {
		return fmt.Errorf("cannot create model directory: %w", err)
	}

	zipPath := filepath.Join(modelDir, "vosk-model.zip")

	log.Printf("[Vosk] Downloading model (~40MB) from %s...", voskModelURL)
	if err := downloadFile(voskModelURL, zipPath); err != nil {
		return fmt.Errorf("failed to download Vosk model: %w", err)
	}

	// Extract zip using PowerShell on Windows
	log.Println("[Vosk] Extracting model...")
	if runtime.GOOS == "windows" {
		cmd := exec.Command("powershell", "-Command",
			fmt.Sprintf("Expand-Archive -Path '%s' -DestinationPath '%s' -Force", zipPath, modelDir))
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			os.Remove(zipPath)
			return fmt.Errorf("failed to extract Vosk model: %w", err)
		}
	}

	// Clean up zip
	os.Remove(zipPath)

	if !IsVoskModelInstalled(dataDir) {
		return fmt.Errorf("model directory not found after extraction")
	}

	log.Println("[Vosk] Model installed successfully")
	return nil
}

// HandleSTT is the HTTP handler for POST /stt that accepts WAV audio and returns transcribed text.
func HandleSTT(dataDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(204)
			return
		}

		if r.Method != "POST" {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}

		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Content-Type", "application/json")

		// Read the audio data from the request body
		audioData, err := io.ReadAll(io.LimitReader(r.Body, 50*1024*1024)) // 50MB limit
		if err != nil {
			json.NewEncoder(w).Encode(map[string]string{"error": "Failed to read audio data"})
			return
		}
		defer r.Body.Close()

		if len(audioData) == 0 {
			json.NewEncoder(w).Encode(map[string]string{"error": "No audio data received"})
			return
		}

		// Save to temp file for processing
		tmpFile, err := os.CreateTemp("", "vosk-audio-*.wav")
		if err != nil {
			json.NewEncoder(w).Encode(map[string]string{"error": "Failed to create temp file"})
			return
		}
		tmpPath := tmpFile.Name()
		defer os.Remove(tmpPath)

		if _, err := tmpFile.Write(audioData); err != nil {
			tmpFile.Close()
			json.NewEncoder(w).Encode(map[string]string{"error": "Failed to write audio data"})
			return
		}
		tmpFile.Close()

		// Transcribe with Vosk
		text, err := transcribeWithVosk(dataDir, tmpPath)
		if err != nil {
			log.Printf("[Vosk] Transcription error: %v", err)
			json.NewEncoder(w).Encode(map[string]string{
				"error": fmt.Sprintf("Transcription failed: %v", err),
			})
			return
		}

		json.NewEncoder(w).Encode(map[string]string{"text": text})
	}
}

// transcribeWithVosk uses the Python vosk module to transcribe audio.
func transcribeWithVosk(dataDir string, audioPath string) (string, error) {
	modelPath := VoskModelPath(dataDir)
	if !IsVoskModelInstalled(dataDir) {
		return "", fmt.Errorf("Vosk model not installed")
	}

	pyCmd := findPython()
	if pyCmd == "" {
		return "", fmt.Errorf("Python not found")
	}

	pythonScript := fmt.Sprintf(`
import sys, json, wave
from vosk import Model, KaldiRecognizer
model = Model(r"%s")
wf = wave.open(r"%s", "rb")
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetWords(False)
results = []
while True:
    data = wf.readframes(4000)
    if len(data) == 0:
        break
    if rec.AcceptWaveform(data):
        r = json.loads(rec.Result())
        if r.get("text"):
            results.append(r["text"])
final = json.loads(rec.FinalResult())
if final.get("text"):
    results.append(final["text"])
print(" ".join(results))
`, modelPath, audioPath)

	cmd := exec.Command(pyCmd, "-c", pythonScript)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("vosk transcription failed: %w", err)
	}

	return strings.TrimSpace(string(output)), nil
}

// InitVosk initializes the Vosk STT system.
func InitVosk(dataDir string) {
	voskState.ModelPath = VoskModelPath(dataDir)
	voskState.Installed = IsVoskModelInstalled(dataDir)
	voskState.PythonFound = findPython() != ""
	voskState.VoskPkgReady = isVoskPkgInstalled(findPython())

	if voskState.Installed && voskState.VoskPkgReady {
		voskState.Running = true
		log.Printf("[Vosk] Ready (model: %s)", voskState.ModelPath)
	} else if !voskState.PythonFound {
		voskState.Error = "Python not found in PATH"
		log.Println("[Vosk] Warning: Python not found. Install Python from https://python.org")
	} else if !voskState.VoskPkgReady {
		voskState.Error = "vosk package not installed"
		log.Println("[Vosk] Warning: vosk Python package not ready")
	} else {
		log.Println("[Vosk] Model not installed — will download on first use or via /install-local")
	}
}

// GetVoskStatus returns the current Vosk status for health checks.
func GetVoskStatus() ServiceStatus {
	if !voskState.Installed || !voskState.VoskPkgReady {
		if voskState.Error != "" {
			return ServiceStatus{Status: "not_installed", Error: voskState.Error}
		}
		return ServiceStatus{Status: "not_installed"}
	}

	return ServiceStatus{Status: "running"}
}

// pollVoskReady checks if vosk becomes usable within a timeout.
func pollVoskReady(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status := GetVoskStatus()
		if status.Status == "running" {
			return true
		}
		time.Sleep(1 * time.Second)
	}
	return false
}
