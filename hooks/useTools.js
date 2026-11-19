import { useState, useEffect, useCallback, useRef } from "react";

let _toolsScriptsPromise = null;
const MAX_TOOLS_FILE_BYTES = 15 * 1024 * 1024;

export function useTools({
  automationCommanderSheetId,
  allOutgoingsClients,
  eomMonthKey,
  setEomStatusOverrides
}) {
  const [toolsScriptsLoaded, setToolsScriptsLoaded] = useState(false);
  const [toolsFiles, setToolsFiles] = useState([]);
  const toolsFilesRef = useRef(toolsFiles);
  toolsFilesRef.current = toolsFiles;
  const [toolsBatchRunning, setToolsBatchRunning] = useState(false);

  const loadToolsScripts = useCallback(() => {
    if (typeof window !== "undefined" && window.pdfjsLib && window.XLSX) {
      setToolsScriptsLoaded(true);
      return Promise.resolve();
    }
    if (_toolsScriptsPromise) return _toolsScriptsPromise;
    _toolsScriptsPromise = (async () => {
      try {
        const [xlsxMod, pdfjsMod] = await Promise.all([
          import("xlsx"),
          import(/* webpackIgnore: true */ "/vendor/pdfjs/pdf.min.mjs"),
        ]);
        const XLSX = xlsxMod?.default?.read ? xlsxMod.default : xlsxMod;
        const pdfjsLib = pdfjsMod?.getDocument ? pdfjsMod : (pdfjsMod?.default || window.pdfjsLib);
        if (!XLSX?.read || !pdfjsLib?.getDocument) {
          throw new Error("Local document parsers failed to initialize.");
        }
        pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
        window.XLSX = XLSX;
        window.pdfjsLib = pdfjsLib;
        setToolsScriptsLoaded(true);
      } catch (err) {
        _toolsScriptsPromise = null;
        throw err;
      }
    })();
    return _toolsScriptsPromise;
  }, []);

  const updateToolsFile = useCallback((id, updates) => {
    setToolsFiles(prev => prev.map(f => f.id === id ? { ...f, ...updates } : f));
  }, []);

  const detectClientForFileId = useCallback(async (id, uploadId, fileName, toolType) => {
    updateToolsFile(id, { detectStatus: "detecting" });
    try {
      const action = toolType === "time" ? "identify_time_client" : "identify_payroll_client";
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, uploadId, fileName, automationCommanderSheetId })
      });
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
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "upload_payroll_chunk", uploadId, chunkData: chunk, isFirstChunk: i === 0 })
        });
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
    if (file?.size > MAX_TOOLS_FILE_BYTES) {
      updateToolsFile(id, { convertStatus: "error", convertMsg: "File exceeds 15 MB limit. Please upload a smaller file." });
      return;
    }
    updateToolsFile(id, { convertStatus: "converting", convertMsg: "Preparing file..." });
    try {
      const lowerName = (file.name || "").toLowerCase();

      // CSV files are plain text - read directly without external library dependencies
      if (lowerName.endsWith(".csv")) {
        const text = await file.text();
        const cleanText = text.replace(/^\uFEFF/, "");
        await uploadAndDetect(id, { data: cleanText, type: "text", fileName: file.name }, file.name, toolType);
        return;
      }

      if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
        if (!toolsScriptsLoaded) await loadToolsScripts();
        const buf = await file.arrayBuffer();
        const workbook = window.XLSX.read(new Uint8Array(buf), {
          type: "array",
          cellFormula: false,
          cellHTML: false,
          sheetRows: 25000,
        });
        let excelText = "";
        workbook.SheetNames.forEach(sheetName => {
          excelText += `--- SHEET: ${sheetName} ---\n`;
          excelText += window.XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]) + "\n\n";
        });
        await uploadAndDetect(id, { data: excelText, type: "text", fileName: file.name }, file.name, toolType);
        return;
      }

      if (file.type === "application/pdf" || lowerName.endsWith(".pdf")) {
        if (!toolsScriptsLoaded) await loadToolsScripts();
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
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

      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
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
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        updateToolsFile(id, { convertStatus: "error", convertMsg: "Failed to read image file." });
      };
      img.src = objectUrl;
    } catch (err) {
      const errorMsg = err?.message || (typeof err === "string" ? err : "Unknown error reading file");
      updateToolsFile(id, { convertStatus: "error", convertMsg: "Error reading file: " + errorMsg });
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
    const target = (toolsFilesRef.current || []).find(f => f.id === id);
    if (!target) return;
    const client = (allOutgoingsClients || []).find(c => c.clientName === target.client);
    if (!client || !target.uploadId) return;
    const isTime = target.toolType === "time";

    if (isTime && !client.masterSheetId) {
      updateToolsFile(id, { processStatus: "error", processMsg: "This client is missing time tracking configuration in Pulse." });
      return;
    }

    updateToolsFile(id, {
      processStatus: "processing",
      pendingConfirm: null,
      processMsg: confirmedMonth ? `Saving data to ${confirmedMonth}...` : `Sending to AI for ${isTime ? "time report" : "payroll"} processing...`,
    });

    try {
      const action = isTime ? "process_time_document" : "process_payroll_document";
      const body = isTime
        ? { action, masterSheetId: client.masterSheetId, clientName: target.client, uploadId: target.uploadId, confirmedMonth: confirmedMonth || undefined, automationCommanderSheetId }
        : { action, clientSheetId: client.clientSheetId, clientName: target.client, uploadId: target.uploadId, confirmedMonth: confirmedMonth || undefined, automationCommanderSheetId };
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!d.success) {
        updateToolsFile(id, { processStatus: "error", processMsg: d.error || "Failed to process document" });
        return;
      }
      if (d.status === "CONFIRM_PERIOD") {
        updateToolsFile(id, { processStatus: "confirm_period", pendingConfirm: { extractedData: d.extractedData, fallback: d.fallback }, processMsg: "" });
        return;
      }
      if (d.status === "ACTION_REQUIRED" || d.requiresForecastResolution) {
        updateToolsFile(id, {
          processStatus: "action_required",
          result: { ...d, resolvedForecastEmployees: [] },
          processMsg: "",
        });
        return;
      }
      updateToolsFile(id, { processStatus: d.writeSuccess ? "complete" : "error", result: d, processMsg: d.writeSuccess ? "" : (d.error || "Write failed") });

      if (d.writeSuccess) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "eom_get_month_status", monthKey: eomMonthKey, automationCommanderSheetId }),
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

  const resolvePayrollForecastEmployee = useCallback(async (fileId, emp, resolutionAction, newStartDate) => {
    const targetFile = (toolsFiles || []).find(f => f.id === fileId);
    if (!targetFile || !targetFile.result) return;
    const client = (allOutgoingsClients || []).find(c => c.clientName === targetFile.client);
    if (!client?.clientSheetId) return;

    const currentBlocking = targetFile.result.blockingForecastEmployees || [];
    const remainingAfter = currentBlocking.filter(b => b.sheetRow !== emp.sheetRow);
    const completeTask = remainingAfter.length === 0;

    const res = await fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "resolve_payroll_import_forecast",
        clientSheetId: client.clientSheetId,
        masterSheetId: client.masterSheetId,
        clientName: targetFile.client,
        sheetRow: emp.sheetRow,
        colStartLetter: emp.colStartLetter || targetFile.result.startCol,
        monthLabel: emp.monthLabel || targetFile.result.targetMonthStr,
        resolutionAction,
        newStartDate,
        completeTask,
        automationCommanderSheetId,
      }),
    });
    const d = await res.json();
    if (!res.ok || !d.success) {
      throw new Error(d.error || "Failed to apply resolution.");
    }

    const actionLabels = {
      zero_out: `Zeroed out for ${emp.monthLabel || targetFile.result.targetMonthStr}`,
      update_start_date: `Moved start date to ${d.formattedStartDate || newStartDate}`,
      keep_forecast: `Confirmed to stay on forecast for ${emp.monthLabel || targetFile.result.targetMonthStr}`,
    };

    setToolsFiles(prev => prev.map(f => {
      if (f.id !== fileId || !f.result) return f;
      const nextBlocking = (f.result.blockingForecastEmployees || []).filter(b => b.sheetRow !== emp.sheetRow);
      const nextResolved = [
        ...(f.result.resolvedForecastEmployees || []),
        { ...emp, resolutionAction, resolutionSummary: actionLabels[resolutionAction] || "Resolved" },
      ];
      return {
        ...f,
        processStatus: nextBlocking.length === 0 ? "complete" : "action_required",
        result: {
          ...f.result,
          blockingForecastEmployees: nextBlocking,
          resolvedForecastEmployees: nextResolved,
          requiresForecastResolution: nextBlocking.length > 0,
        },
      };
    }));

    if (completeTask) {
      fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "eom_get_month_status", monthKey: eomMonthKey, automationCommanderSheetId }),
      })
        .then(r => r.json())
        .then(statusD => {
          if (statusD.success && setEomStatusOverrides) setEomStatusOverrides(statusD.statusOverrides || []);
        })
        .catch(e => console.error("Auto-refresh status error:", e));
    }

    return d;
  }, [allOutgoingsClients, automationCommanderSheetId, eomMonthKey, setEomStatusOverrides, toolsFiles]);

  const toolsFileStats = useCallback((toolType) => {
    const files = (toolsFiles || []).filter(f => (f.toolType || "payroll") === toolType);
    const stillResolving = files.filter(f => f.convertStatus !== "error" && (f.convertStatus !== "ready" || !f.client));
    const readyToStart = stillResolving.length === 0 && files.some(f => f.convertStatus === "ready" && f.client && f.processStatus === "pending");
    const completeCount = files.filter(f => f.processStatus === "complete").length;
    const actionRequiredCount = files.filter(f => f.processStatus === "action_required").length;
    const errorCount = files.filter(f => f.processStatus === "error").length;
    return { files, stillResolving, readyToStart, completeCount, actionRequiredCount, errorCount };
  }, [toolsFiles]);

  return {
    toolsScriptsLoaded,
    toolsFiles,
    toolsBatchRunning,
    handleToolsFilesSelect,
    startToolsBatch,
    updateToolsFile,
    processOneToolsFile,
    resolvePayrollForecastEmployee,
    toolsFileStats
  };
}