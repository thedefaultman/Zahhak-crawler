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
	"strconv"
	"strings"
	"time"
)

const (
	cdpProbeTimeout    = 2 * time.Second
	chromeRestartWait  = 20 * time.Second
	chromeShutdownWait = 15 * time.Second
	chromeForceWait    = 5 * time.Second
	pollInterval       = 300 * time.Millisecond
)

// CDPResult holds the outcome of the Chrome CDP setup attempt.
type CDPResult struct {
	CDPURL string // WebSocket URL like "ws://127.0.0.1:XXXXX/devtools/browser/UUID"
	Method string // "existing" | "restarted" | "fallback"
	Error  error
}

// cdpVersionResponse models the JSON from http://127.0.0.1:<port>/json/version
type cdpVersionResponse struct {
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

// EnsureChromeCDP detects or establishes a CDP connection to the user's Chrome.
// If extensionPath is non-empty, Chrome is launched with --load-extension to auto-load it.
func EnsureChromeCDP(extensionPath string) CDPResult {
	// Fast path: Chrome is already running with CDP enabled (e.g. from a previous session)
	if url, err := detectExistingCDP(); err == nil && url != "" {
		fmt.Println("[Chrome] Already running with DevTools Protocol enabled.")
		return CDPResult{CDPURL: url, Method: "existing"}
	}

	// Chrome is running without CDP, or not running at all. Restart it.
	fmt.Println("[Chrome] Restarting browser with DevTools Protocol...")
	fmt.Println("         Your tabs will be restored automatically.")
	fmt.Println()

	if url, err := restartChromeWithCDP(extensionPath); err == nil && url != "" {
		fmt.Println("[Chrome] Ready. Connected via DevTools Protocol.")
		return CDPResult{CDPURL: url, Method: "restarted"}
	} else {
		log.Printf("[Chrome] Could not connect to your browser: %v", err)
		fmt.Println("[Chrome] Falling back to PinchTab's built-in browser.")
		return CDPResult{Method: "fallback", Error: err}
	}
}

// detectExistingCDP checks if Chrome already has a CDP port open by reading
// DevToolsActivePort and probing the endpoint.
func detectExistingCDP() (string, error) {
	userDataDir := chromeUserDataDir()
	if userDataDir == "" {
		return "", fmt.Errorf("unsupported platform for Chrome detection")
	}

	port, err := readDevToolsActivePort(userDataDir)
	if err != nil {
		return "", err
	}

	url, err := probeCDPWebSocketURL(port)
	if err != nil {
		return "", fmt.Errorf("stale DevToolsActivePort (port %d not responding): %w", port, err)
	}

	return url, nil
}

// restartChromeWithCDP gracefully closes Chrome, relaunches it with CDP enabled,
// auto-loads the extension if extensionPath is provided, and returns the WebSocket URL.
func restartChromeWithCDP(extensionPath string) (string, error) {
	chromePath := chromeExecutablePath()
	if chromePath == "" {
		return "", fmt.Errorf("Chrome executable not found")
	}

	userDataDir := chromeUserDataDir()
	if userDataDir == "" {
		return "", fmt.Errorf("cannot determine Chrome user data directory")
	}

	// Detect active profile before shutdown so we can relaunch the right one
	activeProfile := detectActiveProfile(userDataDir)
	if activeProfile != "" {
		fmt.Printf("  Detected active profile: %s\n", activeProfile)
	}

	// Phase 1: If Chrome is running, shut it down gracefully
	if isChromeRunning() {
		fmt.Println("  Closing Chrome gracefully (saving your session)...")
		if err := gracefulChromeShutdown(); err != nil {
			log.Printf("  Warning: graceful shutdown signal returned: %v", err)
		}
		if !waitForChromeExit(chromeShutdownWait) {
			// Graceful close timed out — force kill as last resort
			fmt.Println("  Chrome is still running — force closing...")
			forceChromeShutdown()
			if !waitForChromeExit(chromeForceWait) {
				return "", fmt.Errorf("Chrome did not exit after force close")
			}
		}
		time.Sleep(500 * time.Millisecond)
	}

	// Phase 2: Remove stale DevToolsActivePort so we can detect the fresh one
	portFilePath := filepath.Join(userDataDir, "DevToolsActivePort")
	os.Remove(portFilePath)

	// Phase 3: Launch Chrome with CDP, session restore, and extension
	// Pass --profile-directory to skip the profile picker on multi-profile setups
	fmt.Println("  Launching Chrome with DevTools Protocol...")
	args := []string{
		"--remote-debugging-port=0",
		"--restore-last-session",
		"--disable-session-crashed-bubble",
		"--no-first-run",
	}
	if activeProfile != "" {
		args = append(args, "--profile-directory="+activeProfile)
	}
	if extensionPath != "" {
		args = append(args, "--load-extension="+extensionPath)
		fmt.Printf("  Loading extension from: %s\n", extensionPath)
	}
	cmd := exec.Command(chromePath, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("failed to launch Chrome: %w", err)
	}

	// Let Chrome run independently — don't block on it
	go cmd.Wait()

	// Phase 4: Wait for DevToolsActivePort to appear
	port, err := waitForDevToolsActivePort(userDataDir, chromeRestartWait)
	if err != nil {
		return "", err
	}

	// Phase 5: Brief delay then probe CDP
	time.Sleep(300 * time.Millisecond)
	url, err := probeCDPWebSocketURL(port)
	if err != nil {
		return "", fmt.Errorf("Chrome started but CDP probe failed on port %d: %w", port, err)
	}

	return url, nil
}

// chromeUserDataDir returns the default Chrome user data directory for the current OS.
func chromeUserDataDir() string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "User Data")
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", "Google", "Chrome")
	case "linux":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, ".config", "google-chrome")
	default:
		return ""
	}
}

// chromeExecutablePath finds the Chrome binary on the current platform.
func chromeExecutablePath() string {
	switch runtime.GOOS {
	case "windows":
		candidates := []string{
			filepath.Join(os.Getenv("PROGRAMFILES"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("PROGRAMFILES(X86)"), "Google", "Chrome", "Application", "chrome.exe"),
			filepath.Join(os.Getenv("LOCALAPPDATA"), "Google", "Chrome", "Application", "chrome.exe"),
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				return c
			}
		}
	case "darwin":
		path := "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		if _, err := os.Stat(path); err == nil {
			return path
		}
	case "linux":
		for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium-browser"} {
			if path, err := exec.LookPath(name); err == nil {
				return path
			}
		}
	}
	return ""
}

// readDevToolsActivePort reads the port number from Chrome's DevToolsActivePort file.
func readDevToolsActivePort(userDataDir string) (int, error) {
	path := filepath.Join(userDataDir, "DevToolsActivePort")
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, fmt.Errorf("cannot read DevToolsActivePort: %w", err)
	}
	lines := strings.SplitN(strings.TrimSpace(string(data)), "\n", 2)
	if len(lines) == 0 || lines[0] == "" {
		return 0, fmt.Errorf("DevToolsActivePort is empty")
	}
	port, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	if err != nil {
		return 0, fmt.Errorf("invalid port in DevToolsActivePort: %w", err)
	}
	return port, nil
}

// probeCDPWebSocketURL queries Chrome's /json/version endpoint and returns the WebSocket URL.
func probeCDPWebSocketURL(port int) (string, error) {
	client := &http.Client{Timeout: cdpProbeTimeout}
	url := fmt.Sprintf("http://127.0.0.1:%d/json/version", port)
	resp, err := client.Get(url)
	if err != nil {
		return "", fmt.Errorf("CDP probe failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read CDP response: %w", err)
	}

	var ver cdpVersionResponse
	if err := json.Unmarshal(body, &ver); err != nil {
		return "", fmt.Errorf("invalid CDP JSON: %w", err)
	}

	if ver.WebSocketDebuggerURL == "" {
		return "", fmt.Errorf("webSocketDebuggerUrl is empty in CDP response")
	}

	return ver.WebSocketDebuggerURL, nil
}

// isChromeRunning checks whether Chrome processes are currently active.
func isChromeRunning() bool {
	switch runtime.GOOS {
	case "windows":
		cmd := exec.Command("tasklist", "/FI", "IMAGENAME eq chrome.exe", "/NH")
		output, err := cmd.Output()
		if err != nil {
			return false
		}
		return strings.Contains(strings.ToLower(string(output)), "chrome.exe")
	case "darwin":
		cmd := exec.Command("pgrep", "-x", "Google Chrome")
		return cmd.Run() == nil
	case "linux":
		cmd := exec.Command("pgrep", "-x", "chrome")
		return cmd.Run() == nil
	}
	return false
}

// gracefulChromeShutdown sends a graceful close signal to Chrome.
// On Windows: taskkill without /F sends WM_CLOSE, preserving session.
// On Unix: SIGTERM allows Chrome to save state before exiting.
func gracefulChromeShutdown() error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("taskkill", "/IM", "chrome.exe")
	case "darwin":
		cmd = exec.Command("pkill", "-TERM", "Google Chrome")
	case "linux":
		cmd = exec.Command("pkill", "-TERM", "chrome")
	default:
		return fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}

	return cmd.Run()
}

// forceChromeShutdown force-kills Chrome when graceful shutdown times out.
// On Windows: taskkill /F /IM chrome.exe
func forceChromeShutdown() {
	switch runtime.GOOS {
	case "windows":
		exec.Command("taskkill", "/F", "/IM", "chrome.exe").Run()
	case "darwin":
		exec.Command("pkill", "-KILL", "Google Chrome").Run()
	case "linux":
		exec.Command("pkill", "-KILL", "chrome").Run()
	}
}

// waitForChromeExit polls until Chrome processes have exited or timeout is reached.
func waitForChromeExit(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !isChromeRunning() {
			return true
		}
		time.Sleep(pollInterval)
	}
	return false
}

// waitForDevToolsActivePort polls for the DevToolsActivePort file after Chrome launch.
func waitForDevToolsActivePort(userDataDir string, timeout time.Duration) (int, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		port, err := readDevToolsActivePort(userDataDir)
		if err == nil && port > 0 {
			return port, nil
		}
		time.Sleep(pollInterval)
	}
	return 0, fmt.Errorf("timed out waiting for Chrome to write DevToolsActivePort")
}

// detectActiveProfile finds the most recently used Chrome profile directory.
// Chrome stores profiles as "Default", "Profile 1", "Profile 2", etc.
// We pick the one whose Preferences file was most recently modified.
func detectActiveProfile(userDataDir string) string {
	entries, err := os.ReadDir(userDataDir)
	if err != nil {
		return ""
	}

	var bestProfile string
	var bestTime time.Time

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if name != "Default" && !strings.HasPrefix(name, "Profile ") {
			continue
		}

		// Check the Preferences file — Chrome updates it on every use
		prefsPath := filepath.Join(userDataDir, name, "Preferences")
		info, err := os.Stat(prefsPath)
		if err != nil {
			continue
		}
		if info.ModTime().After(bestTime) {
			bestTime = info.ModTime()
			bestProfile = name
		}
	}

	return bestProfile
}
