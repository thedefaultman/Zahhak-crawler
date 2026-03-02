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

// ServiceManager owns the lifecycle of PinchTab, Whisper, and Llamafile subprocesses.
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
	sm.services["whisper"] = &ManagedService{
		Name:       "whisper",
		Port:       cfg.WhisperPort,
		BinaryPath: sm.binaryPath("whisperfile"),
	}
	sm.services["llamafile"] = &ManagedService{
		Name:       "llamafile",
		Port:       cfg.LlamafilePort,
		BinaryPath: sm.binaryPath("llamafile"),
	}

	for _, svc := range sm.services {
		if _, err := os.Stat(svc.BinaryPath); err == nil {
			svc.Installed = true
		}
	}

	return sm
}

// RefreshInstallStatus should be called after autoInstall to update installed flags.
func (sm *ServiceManager) RefreshInstallStatus() {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	for _, svc := range sm.services {
		if _, err := os.Stat(svc.BinaryPath); err == nil {
			svc.Installed = true
			svc.Error = ""
		}
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
	cmd.Env = append(os.Environ(),
		fmt.Sprintf("BRIDGE_PORT=%d", svc.Port),
		fmt.Sprintf("BRIDGE_TOKEN=%s", sm.config.BridgeToken),
		"BRIDGE_HEADLESS=true",
		"BRIDGE_BIND=127.0.0.1",
		"BRIDGE_NO_RESTORE=true",
	)
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

// StartWhisper launches the Whisperfile speech-to-text subprocess.
func (sm *ServiceManager) StartWhisper() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	svc := sm.services["whisper"]
	if svc.Running {
		return nil
	}
	if !svc.Installed {
		svc.Error = "not_installed"
		return fmt.Errorf("Whisper binary not found at %s", svc.BinaryPath)
	}

	cmd := exec.Command(svc.BinaryPath,
		"--server",
		"--port", fmt.Sprintf("%d", svc.Port),
		"--host", "127.0.0.1",
		"--threads", "4",
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		svc.Error = err.Error()
		return fmt.Errorf("failed to start Whisper: %w", err)
	}

	svc.Cmd = cmd
	svc.Running = true
	svc.Error = ""
	log.Printf("[Whisper] Started on port %d (PID %d)", svc.Port, cmd.Process.Pid)

	go sm.monitor("whisper", cmd)
	return nil
}

// StartLlamafile launches the Llamafile LLM inference subprocess.
func (sm *ServiceManager) StartLlamafile() error {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	svc := sm.services["llamafile"]
	if svc.Running {
		return nil
	}
	if !svc.Installed {
		svc.Error = "not_installed"
		return fmt.Errorf("Llamafile binary not found at %s", svc.BinaryPath)
	}

	cmd := exec.Command(svc.BinaryPath,
		"--server",
		"--port", fmt.Sprintf("%d", svc.Port),
		"--host", "127.0.0.1",
		"--ctx-size", "4096",
		"--threads", "4",
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		svc.Error = err.Error()
		return fmt.Errorf("failed to start Llamafile: %w", err)
	}

	svc.Cmd = cmd
	svc.Running = true
	svc.Error = ""
	log.Printf("[Llamafile] Started on port %d (PID %d)", svc.Port, cmd.Process.Pid)

	go sm.monitor("llamafile", cmd)
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

func (sm *ServiceManager) GetStatus(name string) ServiceStatus {
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
