package main

import (
	"fmt"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// HardwareInfo holds detected system hardware details.
type HardwareInfo struct {
	CPUName    string `json:"cpuName"`
	CPUCores   int    `json:"cpuCores"`
	RAMTotalMB int    `json:"ramTotalMB"`
	GPUName    string `json:"gpuName"`
	VRAMMB     int    `json:"vramMB"`
}

// ModelRecommendation returns the recommended Ollama model tag based on hardware.
type ModelRecommendation struct {
	ModelTag string `json:"modelTag"`
	Reason   string `json:"reason"`
	SizeMB   int    `json:"sizeMB"` // approximate download size
}

// DetectHardware gathers CPU, RAM, and GPU information on Windows.
func DetectHardware() HardwareInfo {
	info := HardwareInfo{
		CPUCores: runtime.NumCPU(),
	}

	info.RAMTotalMB = detectRAM()
	info.CPUName = detectCPUName()
	info.GPUName, info.VRAMMB = detectGPU()

	return info
}

// RecommendModel picks the best Qwen 3.5 model variant for the detected hardware.
func RecommendModel(hw HardwareInfo) ModelRecommendation {
	vram := hw.VRAMMB
	ram := hw.RAMTotalMB

	if vram >= 8192 || ram >= 32768 {
		return ModelRecommendation{
			ModelTag: "qwen3.5:8b",
			Reason:   fmt.Sprintf("VRAM %dMB / RAM %dMB — large enough for 8B model", vram, ram),
			SizeMB:   5000,
		}
	}
	if vram >= 4096 || ram >= 16384 {
		return ModelRecommendation{
			ModelTag: "qwen3.5:4b",
			Reason:   fmt.Sprintf("VRAM %dMB / RAM %dMB — fits 4B model comfortably", vram, ram),
			SizeMB:   2700,
		}
	}
	if vram >= 2048 || ram >= 8192 {
		return ModelRecommendation{
			ModelTag: "qwen3.5:1.5b",
			Reason:   fmt.Sprintf("VRAM %dMB / RAM %dMB — light 1.5B model", vram, ram),
			SizeMB:   1000,
		}
	}
	return ModelRecommendation{
		ModelTag: "qwen3.5:0.6b",
		Reason:   fmt.Sprintf("VRAM %dMB / RAM %dMB — minimal 0.6B model", vram, ram),
		SizeMB:   400,
	}
}

// memoryStatusEx matches the Windows MEMORYSTATUSEX structure.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// detectRAM uses Windows GlobalMemoryStatusEx to get total physical RAM.
func detectRAM() int {
	if runtime.GOOS != "windows" {
		return 0
	}

	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel32.NewProc("GlobalMemoryStatusEx")

	var memStatus memoryStatusEx
	memStatus.Length = uint32(unsafe.Sizeof(memStatus))

	ret, _, _ := proc.Call(uintptr(unsafe.Pointer(&memStatus)))
	if ret == 0 {
		return 0
	}

	return int(memStatus.TotalPhys / 1024 / 1024)
}

// detectCPUName reads the CPU model name via wmic on Windows.
func detectCPUName() string {
	if runtime.GOOS != "windows" {
		return "unknown"
	}

	cmd := exec.Command("wmic", "cpu", "get", "name", "/value")
	output, err := cmd.Output()
	if err != nil {
		return "unknown"
	}

	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Name=") {
			return strings.TrimPrefix(line, "Name=")
		}
	}
	return "unknown"
}

// detectGPU reads GPU name and VRAM from wmic, with nvidia-smi fallback for accurate VRAM.
func detectGPU() (string, int) {
	if runtime.GOOS != "windows" {
		return "unknown", 0
	}

	cmd := exec.Command("wmic", "path", "win32_videocontroller", "get", "name,adapterram", "/value")
	output, err := cmd.Output()
	if err != nil {
		return "unknown", 0
	}

	var gpuName string
	var vramBytes int64

	for _, line := range strings.Split(string(output), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Name=") {
			name := strings.TrimPrefix(line, "Name=")
			if gpuName == "" || isDiscreteGPU(name) {
				gpuName = name
			}
		}
		if strings.HasPrefix(line, "AdapterRAM=") {
			val := strings.TrimPrefix(line, "AdapterRAM=")
			if v, err := strconv.ParseInt(val, 10, 64); err == nil && v > vramBytes {
				vramBytes = v
			}
		}
	}

	vramMB := int(vramBytes / 1024 / 1024)

	// wmic sometimes reports wrong VRAM. Try nvidia-smi for NVIDIA GPUs.
	if strings.Contains(strings.ToLower(gpuName), "nvidia") {
		if nvidiaVRAM := detectNvidiaVRAM(); nvidiaVRAM > 0 {
			vramMB = nvidiaVRAM
		}
	}

	if gpuName == "" {
		gpuName = "unknown"
	}

	return gpuName, vramMB
}

// detectNvidiaVRAM uses nvidia-smi to get accurate total GPU memory.
func detectNvidiaVRAM() int {
	cmd := exec.Command("nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits")
	output, err := cmd.Output()
	if err != nil {
		return 0
	}

	re := regexp.MustCompile(`(\d+)`)
	match := re.FindString(strings.TrimSpace(string(output)))
	if match == "" {
		return 0
	}

	mb, err := strconv.Atoi(match)
	if err != nil {
		return 0
	}
	return mb
}

func isDiscreteGPU(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "nvidia") || strings.Contains(lower, "radeon") || strings.Contains(lower, "amd")
}
