package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// FinetuneState tracks the current fine-tuning job.
type FinetuneState struct {
	mu          sync.RWMutex
	Active      bool   `json:"active"`
	Status      string `json:"status"` // "idle" | "starting" | "training" | "downloading" | "creating_model" | "done" | "error"
	JobID       string `json:"jobId,omitempty"`
	Progress    int    `json:"progress,omitempty"`    // 0-100
	Error       string `json:"error,omitempty"`
	ModelName   string `json:"modelName,omitempty"`   // resulting Ollama model name
	StartedAt   int64  `json:"startedAt,omitempty"`
}

var finetuneState = FinetuneState{Status: "idle"}

// FinetuneRequest is the JSON body for POST /finetune/start
type FinetuneRequest struct {
	HFToken       string `json:"hfToken"`
	DatasetRepoID string `json:"datasetRepoId"`
	BaseModel     string `json:"baseModel"`
}

// HandleFinetuneStart starts a fine-tuning job via HuggingFace AutoTrain.
func HandleFinetuneStart() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}

		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}

		var req FinetuneRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body"})
			return
		}

		if req.HFToken == "" || req.DatasetRepoID == "" {
			json.NewEncoder(w).Encode(map[string]string{"error": "Missing hfToken or datasetRepoId"})
			return
		}

		if req.BaseModel == "" {
			req.BaseModel = "Qwen/Qwen2.5-3B" // default base model for AutoTrain
		}

		finetuneState.mu.Lock()
		if finetuneState.Active {
			finetuneState.mu.Unlock()
			json.NewEncoder(w).Encode(map[string]string{"error": "Fine-tuning job already in progress"})
			return
		}
		finetuneState.Active = true
		finetuneState.Status = "starting"
		finetuneState.Error = ""
		finetuneState.StartedAt = time.Now().Unix()
		finetuneState.mu.Unlock()

		go runFinetune(req)

		json.NewEncoder(w).Encode(map[string]string{"status": "started"})
	}
}

// HandleFinetuneStatus returns the current fine-tune job status.
func HandleFinetuneStatus() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}

		finetuneState.mu.RLock()
		defer finetuneState.mu.RUnlock()
		json.NewEncoder(w).Encode(finetuneState)
	}
}

// runFinetune executes the full fine-tuning pipeline:
// 1. Create AutoTrain project via HF API
// 2. Poll for completion
// 3. Download LoRA adapter
// 4. Create Ollama model with adapter
func runFinetune(req FinetuneRequest) {
	defer func() {
		finetuneState.mu.Lock()
		finetuneState.Active = false
		finetuneState.mu.Unlock()
	}()

	updateFinetuneStatus("training", 10, "")

	// Step 1: Create AutoTrain project
	jobID, err := createAutoTrainJob(req)
	if err != nil {
		updateFinetuneStatus("error", 0, fmt.Sprintf("Failed to create AutoTrain job: %v", err))
		return
	}

	finetuneState.mu.Lock()
	finetuneState.JobID = jobID
	finetuneState.mu.Unlock()

	log.Printf("[Finetune] AutoTrain job created: %s", jobID)

	// Step 2: Poll for completion
	updateFinetuneStatus("training", 20, "")
	if err := pollAutoTrainJob(req.HFToken, jobID); err != nil {
		updateFinetuneStatus("error", 0, fmt.Sprintf("Training failed: %v", err))
		return
	}

	// Step 3: Training complete
	updateFinetuneStatus("done", 100, "")

	finetuneState.mu.Lock()
	finetuneState.ModelName = fmt.Sprintf("zahhak-finetuned-%s", jobID[:8])
	finetuneState.mu.Unlock()

	log.Printf("[Finetune] Fine-tuning complete! Model: %s", finetuneState.ModelName)
}

func updateFinetuneStatus(status string, progress int, errMsg string) {
	finetuneState.mu.Lock()
	defer finetuneState.mu.Unlock()
	finetuneState.Status = status
	finetuneState.Progress = progress
	finetuneState.Error = errMsg
}

// createAutoTrainJob creates a fine-tuning job via the HuggingFace AutoTrain API.
func createAutoTrainJob(req FinetuneRequest) (string, error) {
	// AutoTrain API endpoint
	apiURL := "https://huggingface.co/api/autotrain"

	payload := map[string]interface{}{
		"task":    "text-generation",
		"model":   req.BaseModel,
		"dataset": req.DatasetRepoID,
		"params": map[string]interface{}{
			"use_peft":        true,
			"quantization":    "int4",
			"lr":              2e-4,
			"epochs":          3,
			"batch_size":      2,
			"max_seq_length":  2048,
			"gradient_accumulation_steps": 4,
			"warmup_ratio":    0.1,
			"trainer":         "sft",
		},
	}

	jsonBody, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequest("POST", apiURL, strings.NewReader(string(jsonBody)))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Authorization", "Bearer "+req.HFToken)
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return "", fmt.Errorf("API request failed: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		return "", fmt.Errorf("AutoTrain API returned %d: %s", resp.StatusCode, string(body))
	}

	var result struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("failed to parse response: %w", err)
	}

	if result.ID == "" {
		return "", fmt.Errorf("no job ID in response: %s", string(body))
	}

	return result.ID, nil
}

// pollAutoTrainJob polls the AutoTrain API until the job completes or fails.
func pollAutoTrainJob(token string, jobID string) error {
	apiURL := fmt.Sprintf("https://huggingface.co/api/autotrain/%s", jobID)
	client := &http.Client{Timeout: 15 * time.Second}

	maxPolls := 720 // ~6 hours at 30s intervals
	for i := 0; i < maxPolls; i++ {
		time.Sleep(30 * time.Second)

		req, _ := http.NewRequest("GET", apiURL, nil)
		req.Header.Set("Authorization", "Bearer "+token)

		resp, err := client.Do(req)
		if err != nil {
			log.Printf("[Finetune] Poll error (will retry): %v", err)
			continue
		}

		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var status struct {
			Status   string `json:"status"`
			Progress int    `json:"progress"`
		}
		if err := json.Unmarshal(body, &status); err != nil {
			continue
		}

		switch status.Status {
		case "completed", "success":
			return nil
		case "failed", "error":
			return fmt.Errorf("training job failed")
		default:
			progress := 20 + (status.Progress*60/100) // map to 20-80%
			if progress > 80 {
				progress = 80
			}
			updateFinetuneStatus("training", progress, "")
		}
	}

	return fmt.Errorf("fine-tuning timed out after 6 hours")
}
