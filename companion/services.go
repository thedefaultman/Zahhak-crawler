package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// ServiceManager owns the lifecycle of PinchTab (subprocess) and tracks Ollama/Vosk status.
type ServiceManager struct {
	config   Config
	mu       sync.RWMutex
	services map[string]*ManagedService
}

// ManagedService tracks a subprocess managed by ServiceManager.
type ManagedService struct {
	Name       string
	Port       int
	Cmd        *exec.Cmd
	Running    bool
	Error      string
	Installed  bool
	BinaryPath string
}

func NewServiceManager(cfg Config) *ServiceManager {
	sm := &ServiceManager{
		config:   cfg,
		services: make(map[string]*ManagedService),
	}

	sm.services["pinchtab"] = &ManagedService{
		Name:       "pinchtab",
		Port:       cfg.PinchTabPort,
		BinaryPath: sm.binaryPath("pinchtab"),
	}

	// Check install status for PinchTab
	if _, err := os.Stat(sm.services["pinchtab"].BinaryPath); err == nil {
		sm.services["pinchtab"].Installed = true
	}

	return sm
}

// SetCDPURL updates the CDP URL in the service manager's config.
func (sm *ServiceManager) SetCDPURL(url string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	sm.config.CDPURL = url
}

// RefreshInstallStatus should be called after autoInstall to update installed flags.
func (sm *ServiceManager) RefreshInstallStatus() {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	svc := sm.services["pinchtab"]
	if _, err := os.Stat(svc.BinaryPath); err == nil {
		svc.Installed = true
		svc.Error = ""
	}
}

func (sm *ServiceManager) binaryPath(name string) string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return filepath.Join(sm.config.DataDir, "bin", name+ext)
}

// StartPinchTab launches the PinchTab subprocess and blocks until it is ready.
func (sm *ServiceManager) StartPinchTab() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	svc := sm.services["pinchtab"]
	if svc.Running {
		return nil
	}

	if !svc.Installed {
		svc.Error = "not_installed"
		return fmt.Errorf("PinchTab binary not found at %s", svc.BinaryPath)
	}

	cmd := exec.Command(svc.BinaryPath)
	env := append(os.Environ(),
		fmt.Sprintf("BRIDGE_PORT=%d", svc.Port),
		fmt.Sprintf("BRIDGE_TOKEN=%s", sm.config.BridgeToken),
		"BRIDGE_HEADLESS=false",
		"BRIDGE_BIND=127.0.0.1",
	)

	if sm.config.CDPURL != "" {
		// CDP mode: connect PinchTab to the user's existing Chrome
		env = append(env, fmt.Sprintf("CDP_URL=%s", sm.config.CDPURL))
		log.Printf("[PinchTab] Connecting to user's Chrome via CDP")
	} else {
		// Fallback: PinchTab launches its own Chrome with a separate profile
		profileDir := filepath.Join(sm.config.DataDir, "chrome-profile")
		env = append(env,
			fmt.Sprintf("BRIDGE_PROFILE=%s", profileDir),
			"BRIDGE_NO_RESTORE=true",
		)
		log.Printf("[PinchTab] Using built-in Chrome (no CDP connection)")
	}

	cmd.Env = env
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		svc.Error = err.Error()
		return fmt.Errorf("failed to start PinchTab: %w", err)
	}

	svc.Cmd = cmd
	svc.Running = true
	svc.Error = ""
	log.Printf("[PinchTab] Started on port %d (PID %d)", svc.Port, cmd.Process.Pid)

	go sm.monitor("pinchtab", cmd)

	sm.mu.Unlock()
	ready := sm.waitForReady(svc.Port, 10*time.Second)
	sm.mu.Lock()

	if !ready {
		svc.Error = "timeout waiting for startup"
		return fmt.Errorf("PinchTab did not become ready")
	}

	return nil
}

func (sm *ServiceManager) StopAll() {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	for name, svc := range sm.services {
		if svc.Running && svc.Cmd != nil && svc.Cmd.Process != nil {
			log.Printf("[%s] Stopping...", name)
			svc.Cmd.Process.Kill()
			svc.Cmd.Wait()
			svc.Running = false
		}
	}
}

// GetStatus returns the status for a named service.
// For "pinchtab" it uses the managed subprocess. For "ollama" and "vosk" it queries their modules.
func (sm *ServiceManager) GetStatus(name string) ServiceStatus {
	switch name {
	case "ollama":
		olStatus := GetOllamaStatus()
		if !olStatus.Installed {
			return ServiceStatus{Status: "not_installed", Port: 11434}
		}
		if olStatus.Pulling {
			return ServiceStatus{Status: "pulling", Port: 11434}
		}
		if olStatus.Running {
			return ServiceStatus{Status: "running", Port: 11434}
		}
		return ServiceStatus{Status: "stopped", Port: 11434}

	case "vosk":
		return GetVoskStatus()

	default:
		// PinchTab and other managed services
		sm.mu.RLock()
		defer sm.mu.RUnlock()

		svc, ok := sm.services[name]
		if !ok {
			return ServiceStatus{Status: "unknown", Port: 0}
		}
		if !svc.Installed {
			return ServiceStatus{Status: "not_installed", Port: svc.Port}
		}
		if svc.Running {
			return ServiceStatus{Status: "running", Port: svc.Port}
		}
		if svc.Error != "" {
			return ServiceStatus{Status: "error", Port: svc.Port, Error: svc.Error}
		}
		return ServiceStatus{Status: "stopped", Port: svc.Port}
	}
}

// monitor watches a subprocess and updates status when it exits
func (sm *ServiceManager) monitor(name string, cmd *exec.Cmd) {
	err := cmd.Wait()
	sm.mu.Lock()
	defer sm.mu.Unlock()

	svc, ok := sm.services[name]
	if !ok {
		return
	}

	svc.Running = false
	if err != nil {
		svc.Error = err.Error()
		log.Printf("[%s] Exited with error: %v", name, err)
	} else {
		log.Printf("[%s] Exited normally", name)
	}
}

// waitForReady polls a port until any HTTP response is received or the timeout expires.
func (sm *ServiceManager) waitForReady(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 1 * time.Second}

	for time.Now().Before(deadline) {
		req, _ := http.NewRequest("GET", fmt.Sprintf("http://localhost:%d/health", port), nil)
		req.Header.Set("Authorization", "Bearer "+sm.config.BridgeToken)
		resp, err := client.Do(req)
		if err == nil {
			resp.Body.Close()
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}
