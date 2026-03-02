package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
)

// Config holds CLI flag values and the generated bridge token.
type Config struct {
	PinchTabPort  int    `json:"pinchtabPort"`
	HealthPort    int    `json:"healthPort"`
	WhisperPort   int    `json:"whisperPort"`
	LlamafilePort int    `json:"llamafilePort"`
	BridgeToken   string `json:"bridgeToken"`
	DataDir       string `json:"dataDir"`
}

var (
	config   Config
	services *ServiceManager
)

func main() {
	ptPort := flag.Int("pinchtab-port", 9867, "PinchTab server port")
	healthPort := flag.Int("health-port", 9868, "Health check API port")
	whisperPort := flag.Int("whisper-port", 8081, "Whisperfile server port")
	llamaPort := flag.Int("llama-port", 8080, "Llamafile server port")
	dataDir := flag.String("data-dir", "", "Directory for downloaded binaries and models")
	tier := flag.String("tier", "cloud", "Tier to set up: 'cloud' (PinchTab only) or 'local' (PinchTab + Whisper + Llamafile)")
	skipInstall := flag.Bool("skip-install", false, "Skip automatic download of missing binaries")
	flag.Parse()

	if *dataDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatal("Cannot determine home directory:", err)
		}
		*dataDir = filepath.Join(home, ".voice-commander")
	}

	if err := os.MkdirAll(*dataDir, 0755); err != nil {
		log.Fatal("Cannot create data directory:", err)
	}

	bridgeToken := loadOrGenerateToken(filepath.Join(*dataDir, "bridge_token"))

	config = Config{
		PinchTabPort:  *ptPort,
		HealthPort:    *healthPort,
		WhisperPort:   *whisperPort,
		LlamafilePort: *llamaPort,
		BridgeToken:   bridgeToken,
		DataDir:       *dataDir,
	}

	fmt.Println("=== Voice Commander Companion ===")
	fmt.Printf("Platform:     %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Printf("Data dir:     %s\n", config.DataDir)
	fmt.Printf("Health API:   http://localhost:%d/health\n", config.HealthPort)
	fmt.Printf("PinchTab:     http://localhost:%d\n", config.PinchTabPort)
	fmt.Printf("Bridge Token: %s...\n", config.BridgeToken[:8])
	fmt.Println()

	services = NewServiceManager(config)

	if !*skipInstall {
		if err := autoInstall(*tier, config.DataDir); err != nil {
			log.Fatalf("Auto-install failed: %v", err)
		}
		services.RefreshInstallStatus()
	}

	if err := services.StartPinchTab(); err != nil {
		log.Printf("Error: Could not start PinchTab: %v", err)
		log.Println("Try re-running the companion app or check your network connection.")
	}

	if *tier == "local" {
		if err := services.StartWhisper(); err != nil {
			log.Printf("Warning: Could not start Whisper: %v", err)
		}
		if err := services.StartLlamafile(); err != nil {
			log.Printf("Warning: Could not start Llamafile: %v", err)
		}
	}

	go startHealthServer()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	fmt.Println("Voice Commander is running. Press Ctrl+C to stop.")
	<-sigChan

	fmt.Println("\nShutting down...")
	services.StopAll()
	fmt.Println("Goodbye!")
}

func startHealthServer() {
	mux := http.NewServeMux()

	corsHandler := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if r.Method == "OPTIONS" {
				w.WriteHeader(204)
				return
			}
			next(w, r)
		}
	}

	mux.HandleFunc("/health", corsHandler(handleHealth))
	mux.HandleFunc("/config", corsHandler(handleConfig))
	mux.HandleFunc("/install-local", corsHandler(handleInstallLocal))

	addr := fmt.Sprintf(":%d", config.HealthPort)
	log.Printf("Health server listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal("Health server error:", err)
	}
}

// ServiceStatus is the per-service JSON payload returned by /health.
type ServiceStatus struct {
	Status string `json:"status"` // "running", "stopped", "error", "not_installed"
	Port   int    `json:"port"`
	Error  string `json:"error,omitempty"`
}

// HealthResponse is the response to GET /health
type HealthResponse struct {
	PinchTab    ServiceStatus `json:"pinchtab"`
	Whisper     ServiceStatus `json:"whisper"`
	Llamafile   ServiceStatus `json:"llamafile"`
	BridgeToken string        `json:"bridgeToken"`
	Platform    string        `json:"platform"`
	Version     string        `json:"version"`
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := HealthResponse{
		PinchTab:    services.GetStatus("pinchtab"),
		Whisper:     services.GetStatus("whisper"),
		Llamafile:   services.GetStatus("llamafile"),
		BridgeToken: config.BridgeToken,
		Platform:    runtime.GOOS + "/" + runtime.GOARCH,
		Version:     "0.2.0",
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(config)
}

// handleInstallLocal lets the extension trigger local tier installation via HTTP
func handleInstallLocal(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	go func() {
		if err := autoInstall("local", config.DataDir); err != nil {
			log.Printf("Local tier install failed: %v", err)
			return
		}
		services.RefreshInstallStatus()

		if err := services.StartWhisper(); err != nil {
			log.Printf("Warning: Could not start Whisper after install: %v", err)
		}
		if err := services.StartLlamafile(); err != nil {
			log.Printf("Warning: Could not start Llamafile after install: %v", err)
		}
	}()

	json.NewEncoder(w).Encode(map[string]string{
		"status":  "installing",
		"message": "Local tier components are being downloaded. Check /health for progress.",
	})
}

// autoInstall downloads any missing binaries and models for the selected tier
func autoInstall(tier string, dataDir string) error {
	binDir := filepath.Join(dataDir, "bin")
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}

	ptPath := filepath.Join(binDir, "pinchtab"+ext)
	if _, err := os.Stat(ptPath); os.IsNotExist(err) {
		fmt.Println("PinchTab not found — downloading automatically...")
		if err := InstallService("pinchtab", dataDir); err != nil {
			return fmt.Errorf("failed to install PinchTab: %w", err)
		}
		fmt.Println("PinchTab installed successfully!")
	}

	if tier == "local" {
		whisperPath := filepath.Join(binDir, "whisperfile"+ext)
		if _, err := os.Stat(whisperPath); os.IsNotExist(err) {
			fmt.Println("Whisperfile not found — downloading (~87MB)...")
			if err := InstallWhisperfile(dataDir); err != nil {
				return fmt.Errorf("failed to install Whisperfile: %w", err)
			}
			fmt.Println("Whisperfile installed successfully!")
		}

		llamaPath := filepath.Join(binDir, "llamafile"+ext)
		if _, err := os.Stat(llamaPath); os.IsNotExist(err) {
			fmt.Println("Llamafile not found — downloading (~2.4GB, this may take a while)...")
			if err := InstallLlamafile(dataDir); err != nil {
				return fmt.Errorf("failed to install Llamafile: %w", err)
			}
			fmt.Println("Llamafile installed successfully!")
		}
	}

	fmt.Println("All required components are ready!")
	return nil
}

func loadOrGenerateToken(path string) string {
	data, err := os.ReadFile(path)
	if err == nil && len(data) > 0 {
		return string(data)
	}

	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		log.Fatal("Cannot generate random token:", err)
	}
	token := hex.EncodeToString(bytes)

	if err := os.WriteFile(path, []byte(token), 0600); err != nil {
		log.Printf("Warning: Could not save bridge token: %v", err)
	}

	return token
}
