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

// Config holds runtime settings
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
	// CLI flags
	ptPort := flag.Int("pinchtab-port", 9867, "PinchTab server port")
	healthPort := flag.Int("health-port", 9868, "Health check API port")
	whisperPort := flag.Int("whisper-port", 8081, "Whisper.cpp server port")
	llamaPort := flag.Int("llama-port", 8080, "Llamafile server port")
	dataDir := flag.String("data-dir", "", "Directory for downloaded binaries and models")
	tier := flag.String("tier", "cloud", "Tier to set up: 'cloud' (PinchTab only) or 'local' (PinchTab + Whisper + Llamafile)")
	skipInstall := flag.Bool("skip-install", false, "Skip automatic download of missing binaries")
	flag.Parse()

	// Determine data directory
	if *dataDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			log.Fatal("Cannot determine home directory:", err)
		}
		*dataDir = filepath.Join(home, ".voice-commander")
	}

	// Ensure data directory exists
	if err := os.MkdirAll(*dataDir, 0755); err != nil {
		log.Fatal("Cannot create data directory:", err)
	}

	// Generate or load bridge token
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

	// Initialize service manager
	services = NewServiceManager(config)

	// Auto-install missing binaries (unless --skip-install)
	if !*skipInstall {
		if err := autoInstall(*tier, config.DataDir); err != nil {
			log.Fatalf("Auto-install failed: %v", err)
		}
		// Refresh installed status after downloads
		services.RefreshInstallStatus()
	}

	// Start PinchTab (required for all tiers)
	if err := services.StartPinchTab(); err != nil {
		log.Printf("Error: Could not start PinchTab: %v", err)
		log.Println("Try re-running the companion app or check your network connection.")
	}

	// Start local tier services if requested
	if *tier == "local" {
		if err := services.StartWhisper(); err != nil {
			log.Printf("Warning: Could not start Whisper: %v", err)
		}
		if err := services.StartLlamafile(); err != nil {
			log.Printf("Warning: Could not start Llamafile: %v", err)
		}
	}

	// Start health check server
	go startHealthServer()

	// Handle graceful shutdown
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

	// CORS middleware
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

// ServiceStatus describes the status of a single service
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
		Version:     "0.1.0",
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

		// Auto-start local services after install
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

	// PinchTab is ALWAYS required (all tiers need it for browser control)
	ptPath := filepath.Join(binDir, "pinchtab"+ext)
	if _, err := os.Stat(ptPath); os.IsNotExist(err) {
		fmt.Println("PinchTab not found — downloading automatically...")
		if err := InstallService("pinchtab", dataDir); err != nil {
			return fmt.Errorf("failed to install PinchTab: %w", err)
		}
		fmt.Println("PinchTab installed successfully!")
	}

	// Local tier: also need whisper.cpp server + model + llamafile
	if tier == "local" {
		whisperPath := filepath.Join(binDir, "whisper-server"+ext)
		if _, err := os.Stat(whisperPath); os.IsNotExist(err) {
			fmt.Println("Whisper.cpp server not found — downloading automatically...")
			if err := InstallService("whisper-server", dataDir); err != nil {
				return fmt.Errorf("failed to install Whisper server: %w", err)
			}
			fmt.Println("Whisper.cpp server installed successfully!")
		}

		// Whisper model
		modelPath := filepath.Join(dataDir, "models", "ggml-tiny.en.bin")
		if _, err := os.Stat(modelPath); os.IsNotExist(err) {
			fmt.Println("Whisper model not found — downloading (~39MB)...")
			if err := InstallModel("ggml-tiny.en.bin", dataDir); err != nil {
				return fmt.Errorf("failed to install Whisper model: %w", err)
			}
			fmt.Println("Whisper model installed successfully!")
		}

		// Llamafile (LLM + runtime in one binary)
		llamaPath := filepath.Join(binDir, "llamafile"+ext)
		if _, err := os.Stat(llamaPath); os.IsNotExist(err) {
			fmt.Println("Llamafile not found — downloading (~2.2GB, this may take a while)...")
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
	// Try to read existing token
	data, err := os.ReadFile(path)
	if err == nil && len(data) > 0 {
		return string(data)
	}

	// Generate new token
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		log.Fatal("Cannot generate random token:", err)
	}
	token := hex.EncodeToString(bytes)

	// Save it
	if err := os.WriteFile(path, []byte(token), 0600); err != nil {
		log.Printf("Warning: Could not save bridge token: %v", err)
	}

	return token
}
