package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
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
	PinchTabPort int    `json:"pinchtabPort"`
	HealthPort   int    `json:"healthPort"`
	BridgeToken  string `json:"bridgeToken"`
	DataDir      string `json:"dataDir"`
	CDPURL       string `json:"cdpUrl,omitempty"`
}

// CompanionVersion is the version of the companion app, must match extension manifest version.
const CompanionVersion = "2.0.0"

var (
	config   Config
	services *ServiceManager
	hwInfo   HardwareInfo
	modelRec ModelRecommendation
)

func main() {
	ptPort := flag.Int("pinchtab-port", 9867, "PinchTab server port")
	healthPort := flag.Int("health-port", 9868, "Health check API port")
	dataDir := flag.String("data-dir", "", "Directory for downloaded binaries and models")
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
		PinchTabPort: *ptPort,
		HealthPort:   *healthPort,
		BridgeToken:  bridgeToken,
		DataDir:      *dataDir,
	}

	fmt.Println("=== Zahhak Companion ===")
	fmt.Printf("Platform:     %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Printf("Data dir:     %s\n", config.DataDir)
	fmt.Printf("Health API:   http://localhost:%d/health\n", config.HealthPort)
	fmt.Printf("PinchTab:     http://localhost:%d\n", config.PinchTabPort)
	fmt.Printf("Bridge Token: %s...\n", config.BridgeToken[:8])
	fmt.Println()

	// Step 1: Detect hardware
	hwInfo = DetectHardware()
	modelRec = RecommendModel(hwInfo)
	fmt.Printf("CPU:          %s (%d cores)\n", hwInfo.CPUName, hwInfo.CPUCores)
	fmt.Printf("RAM:          %d MB\n", hwInfo.RAMTotalMB)
	fmt.Printf("GPU:          %s (%d MB VRAM)\n", hwInfo.GPUName, hwInfo.VRAMMB)
	fmt.Printf("Recommended:  %s (%s)\n", modelRec.ModelTag, modelRec.Reason)
	fmt.Println()

	services = NewServiceManager(config)

	// Step 2: Install PinchTab if missing
	if !*skipInstall {
		if err := autoInstall(config.DataDir); err != nil {
			log.Fatalf("Auto-install failed: %v", err)
		}
		services.RefreshInstallStatus()
	}

	// Step 3: Set up Ollama (install if needed, ensure serving, pull model)
	setupOllama(config.DataDir)

	// Step 4: Launch dedicated Chrome with extension + CDP
	extensionPath := filepath.Join(config.DataDir, "extension")
	cdpResult := LaunchDedicatedChrome(extensionPath, config.DataDir)
	if cdpResult.CDPURL != "" {
		config.CDPURL = cdpResult.CDPURL
		services.SetCDPURL(cdpResult.CDPURL)
		fmt.Printf("CDP URL:      %s\n", config.CDPURL)
	} else {
		log.Printf("Warning: Could not launch Chrome: %v", cdpResult.Error)
		fmt.Println("PinchTab will use its own browser window (extension may not be loaded).")
	}
	fmt.Println()

	// Step 5: Start PinchTab
	if err := services.StartPinchTab(); err != nil {
		log.Printf("Error: Could not start PinchTab: %v", err)
		log.Println("Try re-running the companion app or check your network connection.")
	}

	// Step 6: Start health server
	go startHealthServer()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	fmt.Println("Zahhak Companion is running. Press Ctrl+C to stop.")
	<-sigChan

	fmt.Println("\nShutting down...")
	services.StopAll()
	StopDedicatedChrome()
	fmt.Println("Goodbye!")
}

// setupOllama handles Ollama installation, startup, and model pulling.
func setupOllama(dataDir string) {
	if !IsOllamaInstalled() {
		fmt.Println("[Ollama] Not installed — attempting installation...")
		if err := InstallOllama(dataDir); err != nil {
			log.Printf("Warning: Ollama installation failed: %v", err)
			log.Println("  Install Ollama manually from https://ollama.com")
			return
		}
	}

	fmt.Println("[Ollama] Ensuring server is running...")
	if err := EnsureOllamaServing(); err != nil {
		log.Printf("Warning: Could not start Ollama: %v", err)
		return
	}

	// Pull recommended model
	fmt.Printf("[Ollama] Checking model %s...\n", modelRec.ModelTag)
	if err := PullModel(modelRec.ModelTag); err != nil {
		log.Printf("Warning: Could not pull model %s: %v", modelRec.ModelTag, err)
	}
}

func startHealthServer() {
	mux := http.NewServeMux()

	corsHandler := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
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
	mux.HandleFunc("/hardware", corsHandler(handleHardware))
	mux.HandleFunc("/model/status", corsHandler(handleModelStatus))
	mux.HandleFunc("/install-local", corsHandler(handleInstallLocal))
	mux.HandleFunc("/chat", corsHandler(handleChatProxy))
mux.HandleFunc("/finetune/start", corsHandler(HandleFinetuneStart()))
	mux.HandleFunc("/finetune/status", corsHandler(HandleFinetuneStatus()))

	addr := fmt.Sprintf(":%d", config.HealthPort)
	log.Printf("Health server listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal("Health server error:", err)
	}
}

// ServiceStatus is the per-service JSON payload returned by /health.
type ServiceStatus struct {
	Status string `json:"status"` // "running", "stopped", "error", "not_installed", "pulling"
	Port   int    `json:"port,omitempty"`
	Error  string `json:"error,omitempty"`
}

// HealthResponse is the response to GET /health
type HealthResponse struct {
	PinchTab    ServiceStatus        `json:"pinchtab"`
	Ollama      ServiceStatus        `json:"ollama"`
	Hardware    *HardwareInfo        `json:"hardware,omitempty"`
	ModelName   string               `json:"modelName,omitempty"`
	ModelRec    *ModelRecommendation `json:"modelRecommendation,omitempty"`
	BridgeToken string               `json:"bridgeToken"`
	Platform    string               `json:"platform"`
	Version     string               `json:"version"`
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	olStatus := GetOllamaStatus()

	resp := HealthResponse{
		PinchTab:    services.GetStatus("pinchtab"),
		Ollama:      services.GetStatus("ollama"),
		Hardware:    &hwInfo,
		ModelName:   olStatus.ModelName,
		ModelRec:    &modelRec,
		BridgeToken: config.BridgeToken,
		Platform:    runtime.GOOS + "/" + runtime.GOARCH,
		Version:     CompanionVersion,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func handleConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(config)
}

func handleHardware(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"hardware":       hwInfo,
		"recommendation": modelRec,
	})
}

func handleModelStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(GetOllamaStatus())
}

// handleInstallLocal lets the extension trigger installation of missing components via HTTP
func handleInstallLocal(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	go func() {
		// Install PinchTab
		if err := autoInstall(config.DataDir); err != nil {
			log.Printf("Install failed: %v", err)
			return
		}
		services.RefreshInstallStatus()

		// Set up Ollama
		setupOllama(config.DataDir)

	}()

	json.NewEncoder(w).Encode(map[string]string{
		"status":  "installing",
		"message": "Components are being downloaded. Check /health for progress.",
	})
}

// autoInstall downloads PinchTab if missing.
func autoInstall(dataDir string) error {
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

	// Install extension if missing
	if err := InstallExtension(dataDir); err != nil {
		log.Printf("Warning: Extension install failed: %v", err)
		log.Println("  The extension can still be loaded manually via chrome://extensions")
	}

	fmt.Println("All required components are ready!")
	return nil
}

// handleChatProxy forwards chat completion requests to Ollama, avoiding CORS issues
// when called from a Chrome extension origin.
func handleChatProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}

	// Forward the request body to Ollama's OpenAI-compatible endpoint
	resp, err := http.Post(ollamaAPI+"/v1/chat/completions", "application/json", r.Body)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("Ollama unreachable: %v", err)})
		return
	}
	defer resp.Body.Close()

	// Copy Ollama's response headers and body back to the client
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
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
