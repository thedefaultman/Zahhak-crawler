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
	cdpProbeTimeout   = 2 * time.Second
	chromeStartupWait = 20 * time.Second
	pollInterval      = 300 * time.Millisecond
)

// CDPResult holds the outcome of the Chrome CDP setup attempt.
type CDPResult struct {
	CDPURL string // WebSocket URL like "ws://127.0.0.1:XXXXX/devtools/browser/UUID"
	Method string // "existing" | "launched" | "fallback"
	Error  error
}

// cdpVersionResponse models the JSON from http://127.0.0.1:<port>/json/version
type cdpVersionResponse struct {
	WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
}

// dedicatedChromeCmd holds the Chrome process so we can kill it on shutdown.
var dedicatedChromeCmd *exec.Cmd

// LaunchDedicatedChrome starts a separate Chrome instance with its own profile,
// the Zahhak extension auto-loaded, and CDP enabled. The user's running Chrome
// is never touched.
func LaunchDedicatedChrome(extensionPath, dataDir string) CDPResult {
	chromePath := chromeExecutablePath()
	if chromePath == "" {
		return CDPResult{Method: "fallback", Error: fmt.Errorf("Chrome executable not found")}
	}

	profileDir := filepath.Join(dataDir, "chrome-profile")
	if err := os.MkdirAll(profileDir, 0755); err != nil {
		return CDPResult{Method: "fallback", Error: fmt.Errorf("cannot create chrome profile dir: %w", err)}
	}

	// Fast path: a previous dedicated Chrome may still be running
	if url, err := probeCDPFromProfile(profileDir); err == nil && url != "" {
		fmt.Println("[Chrome] Reusing existing dedicated browser.")
		return CDPResult{CDPURL: url, Method: "existing"}
	}

	// Remove stale DevToolsActivePort so we detect the fresh one
	os.Remove(filepath.Join(profileDir, "DevToolsActivePort"))

	fmt.Println("[Chrome] Launching dedicated browser with extension...")

	args := []string{
		"--user-data-dir=" + profileDir,
		"--remote-debugging-port=0",
		"--no-first-run",
		"--disable-session-crashed-bubble",
	}

	if extensionPath != "" {
		manifest := filepath.Join(extensionPath, "manifest.json")
		if _, err := os.Stat(manifest); err == nil {
			args = append(args, "--load-extension="+extensionPath)
			fmt.Printf("  Extension: %s\n", extensionPath)
		} else {
			log.Printf("  Warning: extension not found at %s — launching without it", extensionPath)
		}
	}

	cmd := exec.Command(chromePath, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return CDPResult{Method: "fallback", Error: fmt.Errorf("failed to launch Chrome: %w", err)}
	}

	dedicatedChromeCmd = cmd
	go cmd.Wait()

	// Wait for DevToolsActivePort to appear in our dedicated profile
	port, err := waitForDevToolsActivePort(profileDir, chromeStartupWait)
	if err != nil {
		return CDPResult{Method: "fallback", Error: err}
	}

	time.Sleep(300 * time.Millisecond)

	url, err := probeCDPWebSocketURL(port)
	if err != nil {
		return CDPResult{Method: "fallback", Error: fmt.Errorf("Chrome started but CDP probe failed: %w", err)}
	}

	// Open a real page so the extension content scripts activate
	openInitialPage(port)

	fmt.Println("[Chrome] Ready with extension loaded.")
	return CDPResult{CDPURL: url, Method: "launched"}
}

// StopDedicatedChrome kills the companion-managed Chrome process.
func StopDedicatedChrome() {
	if dedicatedChromeCmd != nil && dedicatedChromeCmd.Process != nil {
		log.Println("[Chrome] Stopping dedicated browser...")
		dedicatedChromeCmd.Process.Kill()
		dedicatedChromeCmd = nil
	}
}

// probeCDPFromProfile checks if a Chrome with the given profile dir has an active CDP port.
func probeCDPFromProfile(profileDir string) (string, error) {
	port, err := readDevToolsActivePort(profileDir)
	if err != nil {
		return "", err
	}
	return probeCDPWebSocketURL(port)
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
func readDevToolsActivePort(profileDir string) (int, error) {
	path := filepath.Join(profileDir, "DevToolsActivePort")
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

// waitForDevToolsActivePort polls for the DevToolsActivePort file after Chrome launch.
func waitForDevToolsActivePort(profileDir string, timeout time.Duration) (int, error) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		port, err := readDevToolsActivePort(profileDir)
		if err == nil && port > 0 {
			return port, nil
		}
		time.Sleep(pollInterval)
	}
	return 0, fmt.Errorf("timed out waiting for Chrome to write DevToolsActivePort")
}

// openInitialPage uses CDP's REST API to open a page in the dedicated Chrome,
// so the extension's content scripts activate on a real page.
func openInitialPage(cdpPort int) {
	client := &http.Client{Timeout: 5 * time.Second}
	pageURL := fmt.Sprintf("http://127.0.0.1:%d/json/new?https://www.google.com", cdpPort)
	resp, err := client.Get(pageURL)
	if err != nil {
		log.Printf("[Chrome] Could not open initial page: %v", err)
		return
	}
	resp.Body.Close()
}
