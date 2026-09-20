import { useState, useEffect, useCallback } from "react";

export function useTools({
  automationCommanderSheetId,
  allOutgoingsClients,
  eomMonthKey,
  setEomStatusOverrides
}) {
  const [toolsScriptsLoaded, setToolsScriptsLoaded] = useState(false);
  const [toolsFiles, setToolsFiles] = useState([]);
  const [toolsBatchRunning, setToolsBatchRunning] = useState(false);

  const loadToolsScripts = useCallback(() => new Promise((resolve, reject) => {
    if (window.pdfjsLib && window.XLSX) { setToolsScriptsLoaded(true); resolve(); return; }
    let remaining = 2;
    const done = () => { remaining--; if (remaining === 0) { setToolsScriptsLoaded(true); resolve(); } };
    const pdfScript = document.createElement("script");
    pdfScript.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js";
    pdfScript.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js";
      done();
    };
    pdfScript.onerror = reject;
    document.head.appendChild(pdfScript);
    const xlsxScript = document.createElement("script");
    xlsxScript.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    xlsxScript.onload = done;
    xlsxScript.onerror = reject;
    document.head.appendChild(xlsxScript);
  }), []);

  const updateToolsFile = useCallback((id, updates) => {
    setToolsFiles(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  }, []);

  const detectClientForFileId = useCallback(async (id, uploadId, fileName, toolType) => {
    updateToolsFile(id, { detectStatus: "detecting" });
    try {
      const action = toolType === "time" ? "identify_time_client" : "identify_payroll_client";
      const res = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, uploadId, fileName, automationCommanderSheetId }) });
      const d = await res.json();
      if (!d.success) {
        updateToolsFile(id, { detectStatus: "ambiguous", ambiguousInfo: { error: d.error || "Detection failed", employeeNames: [], candidateScores: [] } });
        return;
      }
      if (d.status === "MATCHED") {
        updateToolsFile(id, { detectStatus: "matched", detectMethod: d.method, client: d.clientName });
      } else {
        updateToolsFile(id, { detectStatus: "ambiguous", ambiguousInfo: { employerName: d.employerName, employeeNames: d.employeeNames || [], candidateScores: d.candidateScores || [] } });
      }
    } catch (err) {
      updateToolsFile(id, { detectStatus: "ambiguous", ambiguousInfo: { error: err.message, employeeNames: [], candidateScores: [] } });
    }
  }, [automationCommanderSheetId, updateToolsFile]);

  const CHUNK_SIZE = 3000000;

  const uploadAndDetect = useCallback(async (id, fileData, fileName, toolType) => {
    const uploadId = id; 
    const fullPayload = JSON.stringify(fileData);
    const totalChunks = Math.ceil(fullPayload.length / CHUNK_SIZE);
    try {
      for (let i = 0; i < totalChunks; i++) {
        updateToolsFile(id, { convertMsg: totalChunks > 1 ? `Uploading... ${Math.round(((i + 1) / totalChunks) * 100)}%` : "Uploading..." });
        const chunk = fullPayload.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const res = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "upload_payroll_chunk", uploadId, chunkData: chunk, isFirstChunk: i === 0 }) });
        const d = await res.json();
        if (!d.success) throw new Error(d.error || "Chunk upload failed");
      }
      updateToolsFile(id, { convertStatus: "ready", convertMsg: "Ready.", uploadId });
      detectClientForFileId(id, uploadId, fileName, toolType);
    } catch (err) {
      updateToolsFile(id, { convertStatus: "error", convertMsg: "Upload failed: " + err.message });
    }
  }, [detectClientForFileId, updateToolsFile]);

  const convertOneToolsFile = useCallback(async (id, file, toolType) => {
    updateToolsFile(id, { convertStatus: "converting", convertMsg: "Preparing file..." });
    try {
      if (!toolsScriptsLoaded) await loadToolsScripts();

      if (file.name.endsWith(".xlsx") || file.name.endsWith(".xls") || file.name.endsWith(".csv")) {
        const buf = await file.arrayBuffer();
        const workbook = window.XLSX.read(new Uint8Array(buf), { type: "array" });
        let excelText = "";
        workbook.SheetNames.forEach(sheetName => {
          excelText += `--- SHEET: ${sheetName} ---\n`;
          excelText += window.XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]) + "\n\n";
        });
        await uploadAndDetect(id, { data: excelText, type: "text", fileName: file.name }, file.name, toolType);
        return;
      }

      if (file.type === "application/pdf") {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument(arrayBuffer).promise;
        const scale = 2;
        const images = [];

        for (let i = 1; i <= pdf.numPages; i++) {
          updateToolsFile(id, { convertMsg: `Converting page ${i} of ${pdf.numPages}...` });
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale });
          
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d");
          
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          
          await page.render({ canvasContext: context, viewport }).promise;
          const b64 = canvas.toDataURL("image/jpeg").split(",")[1];
          images.push(b64);
        }
        
        await uploadAndDetect(id, { data: images, type: "image_array", fileName: file.name }, file.name, toolType);
        return;
      }

      const img = new Image();
      img.onload = () => {
        const maxDim = 7900;
        let downscale = 1;
        if (img.height > maxDim || img.width > maxDim) {
          downscale = maxDim / Math.max(img.height, img.width);
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(img.width * downscale);
        canvas.height = Math.floor(img.height * downscale);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        const b64 = canvas.toDataURL("image/jpeg").split(",")[1];
        uploadAndDetect(id, { data: b64, type: "image", fileName: file.name }, file.name, toolType);
      };
      img.onerror = () => updateToolsFile(id, { convertStatus: "error", convertMsg: "Failed to read image file." });
      img.src = URL.createObjectURL(file);
    } catch (err) {
      updateToolsFile(id, { convertStatus: "error", convertMsg: "Error reading file: " + err.message });
    }
  }, [loadToolsScripts, toolsScriptsLoaded, updateToolsFile, uploadAndDetect]);

  const handleToolsFilesSelect = useCallback((fileList, toolType) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const newEntries = files.map(file => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file, fileName: file.name, toolType,
      convertStatus: "pending", convertMsg: "", uploadId: null,
      detectStatus: "idle", detectMethod: "", client: "", ambiguousInfo: null,
      processStatus: "pending", pendingConfirm: null, result: null, processMsg: "",
    }));
    setToolsFiles(prev => [...prev, ...newEntries]);
    newEntries.forEach(entry => convertOneToolsFile(entry.id, entry.file, toolType));
  }, [convertOneToolsFile]);

  const processOneToolsFile = useCallback(async (id, confirmedMonth) => {
    setToolsFiles(prev => {
        const target = prev.find(f => f.id === id);
        if (!target) return prev;
        const client = (allOutgoingsClients || []).find(c => c.clientName === target.client);
        if (!client || !target.uploadId) return prev;
        const isTime = target.toolType === "time";
    
        if (isTime && !client.masterSheetId) {
            return prev.map(f => f.id === id ? { ...f, processStatus: "error", processMsg: "This client has no master sheet linked — can't locate TimeComp." } : f);
        }

        (async () => {
            try {
                const action = isTime ? "process_time_document" : "process_payroll_document";
                const body = isTime
                  ? { action, masterSheetId: client.masterSheetId, clientName: target.client, uploadId: target.uploadId, confirmedMonth: confirmedMonth || undefined, automationCommanderSheetId }
                  : { action, clientSheetId: client.clientSheetId, clientName: target.client, uploadId: target.uploadId, confirmedMonth: confirmedMonth || undefined, automationCommanderSheetId };
                const res = await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body) });
                const d = await res.json();
                if (!d.success) {
                  updateToolsFile(id, { processStatus: "error", processMsg: d.error || "Failed to process document" });
                  return;
                }
                if (d.status === "CONFIRM_PERIOD") {
                  updateToolsFile(id, { processStatus: "confirm_period", pendingConfirm: { extractedData: d.extractedData, fallback: d.fallback }, processMsg: "" });
                  return;
                }
                updateToolsFile(id, { processStatus: d.writeSuccess ? "complete" : "error", result: d, processMsg: d.writeSuccess ? "" : (d.error || "Write failed") });
          
                if (d.writeSuccess) {
                  fetch("/api/triage", { 
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ action: "eom_get_month_status", monthKey: eomMonthKey, automationCommanderSheetId }) 
                  })
                  .then(r => r.json())
                  .then(statusD => {
                    if (statusD.success && setEomStatusOverrides) setEomStatusOverrides(statusD.statusOverrides || []);
                  })
                  .catch(e => console.error("Auto-refresh status error:", e));
                }
              } catch (err) {
                updateToolsFile(id, { processStatus: "error", processMsg: err.message });
              }
        })();

        return prev.map(f => f.id === id ? { ...f, processStatus: "processing", pendingConfirm: null, processMsg: confirmedMonth ? `Saving data to ${confirmedMonth}...` : `Sending to AI for ${isTime ? "time report" : "payroll"} processing...` } : f);
    });
  }, [allOutgoingsClients, automationCommanderSheetId, eomMonthKey, setEomStatusOverrides, updateToolsFile]);

  useEffect(() => {
    if (!toolsBatchRunning) return;
    if (toolsFiles.some(f => f.processStatus === "processing")) return;
    const findNextQueuedFile = (files) => files.find(f => f.convertStatus === "ready" && f.client && f.processStatus === "pending");
    const next = findNextQueuedFile(toolsFiles);
    if (next) {
      processOneToolsFile(next.id);
    } else {
      setToolsBatchRunning(false);
    }
  }, [toolsFiles, toolsBatchRunning, processOneToolsFile]);

  const startToolsBatch = useCallback(() => {
    setToolsBatchRunning(true);
  }, []);

  const toolsFileStats = useCallback((toolType) => {
    const files = (toolsFiles || []).filter(f => (f.toolType || "payroll") === toolType);
    const stillResolving = files.filter(f => f.convertStatus !== "error" && (f.convertStatus !== "ready" || !f.client));
    const readyToStart = stillResolving.length === 0 && files.some(f => f.convertStatus === "ready" && f.client && f.processStatus === "pending");
    const completeCount = files.filter(f => f.processStatus === "complete").length;
    const errorCount = files.filter(f => f.processStatus === "error").length;
    return { files, stillResolving, readyToStart, completeCount, errorCount };
  }, [toolsFiles]);

  return {
    toolsScriptsLoaded,
    toolsFiles,
    toolsBatchRunning,
    handleToolsFilesSelect,
    startToolsBatch,
    updateToolsFile,
    processOneToolsFile,
    toolsFileStats
  };
}