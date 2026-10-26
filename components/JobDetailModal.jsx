import React, { useState, useEffect, useMemo } from "react";
import Spinner from "./Spinner";
import UnevenSplitModal from "./UnevenSplitModal";
import InvoicesEditModal from "./InvoicesEditModal";
import DirectCostsEditModal from "./DirectCostsEditModal";
import CellNoteModal from "./CellNoteModal";
import NoteIndicatorButton from "./NoteIndicatorButton";
import PlaceholderPill, { isAutoPlaceholder, generatePlaceholderInvoiceRef } from "./PlaceholderPill";
import {
  JobDateInput,
  parseSheetDate,
  addMonths,
  toSheetDateFormat,
  formatCurrency,
  parseLikelihoodValue
} from "./JobsView";
import {
  isPlaceholderInvoice,
  isPlaceholderExpense,
  getRetainerRowMonthLabel,
  hasActiveAccountingIntegration,
  hasActiveCrmIntegration,
  isCrmDrivenTab,
  isCrmDeal,
  getCrmDisplayName,
  calculatePaymentDate,
  groupSlotItemsForDisplay
} from "../utils/helpers";
import CrmSyncBadge, { CrmSyncIcon } from "./CrmSyncBadge";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useAuth } from "../hooks/useAuth";

export default function JobDetailModal({
  isOpen,
  target,
  onClose,
  onMarkPullPending
}) {
  const { allClientsMap } = useAppGlobals();
  const [internalClientsMap, setInternalClientsMap] = useState(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const [productLines, setProductLines] = useState([]);
  const [leadSources, setLeadSources] = useState([]);
  const [draftEdits, setDraftEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [recentlySaved, setRecentlySaved] = useState(false);
  const [allJobs, setAllJobs] = useState([]);
  const auth = useAuth();
  const user = auth?.user;
  const [crmTool, setCrmTool] = useState(() => target?.crmTool || target?.client?.crmTool || null);
  const [crmDrives, setCrmDrives] = useState(() => target?.crmDrives || target?.client?.crmDrives || null);
  const [hasAccountingIntegration, setHasAccountingIntegration] = useState(() => {
    return Boolean(
      target?.hasAccountingIntegration ||
      target?.client?.hasAccountingIntegration ||
      hasActiveAccountingIntegration(target?.client?.accountingTool)
    );
  });
  const [reloadTrigger, setReloadTrigger] = useState(0);

  // Sub-modals state
  const [invoicesEditSlot, setInvoicesEditSlot] = useState(null);
  const [directCostsEditSlot, setDirectCostsEditSlot] = useState(null);
  const [jobsEditSplit, setJobsEditSplit] = useState(null);
  const [cellNoteModalConfig, setCellNoteModalConfig] = useState(null);

  // Combine global map and fallback loaded map
  const activeClientsMap = useMemo(() => {
    return { ...(allClientsMap || {}), ...(internalClientsMap || {}) };
  }, [allClientsMap, internalClientsMap]);

  // Helper to find clientSheetId and client object across target properties and activeClientsMap
  const resolvedClientInfo = useMemo(() => {
    let client = (target?.client && typeof target.client === "object") ? { ...target.client } : {};
    let clientSheetId =
      target?.clientSheetId ||
      client?.clientSheetId ||
      client?.sheetId ||
      client?.client_sheet_id ||
      null;

    const candidateNames = [
      target?.clientName,
      client?.clientName,
      client?.name,
      target?.endClientName
    ].filter(Boolean);

    if (activeClientsMap && Object.keys(activeClientsMap).length > 0) {
      for (const name of candidateNames) {
        const trimmed = String(name).trim();
        const matched = activeClientsMap[trimmed] || Object.values(activeClientsMap).find((c) => c.clientName?.toLowerCase() === trimmed.toLowerCase());
        if (matched) {
          // Guard: If clientSheetId was erroneously populated with the Master Sheet ID, correct it to the actual Client Sheet ID
          if (matched.masterSheetId && clientSheetId === matched.masterSheetId && matched.clientSheetId) {
            clientSheetId = matched.clientSheetId;
          }
          if (!clientSheetId) {
            clientSheetId = matched.clientSheetId || matched.sheetId || null;
          }
          client = { ...(matched || {}), ...(client || {}), clientSheetId, clientName: matched.clientName || trimmed };
          break;
        }
      }
    } else if (clientSheetId) {
      client.clientSheetId = clientSheetId;
      if (!client.clientName && target?.clientName) {
        client.clientName = target.clientName;
      }
    }

    return { client, clientSheetId };
  }, [target, activeClientsMap]);

  useEffect(() => {
    if (target?.hasAccountingIntegration !== undefined) {
      setHasAccountingIntegration(Boolean(target.hasAccountingIntegration));
    } else if (resolvedClientInfo?.client?.hasAccountingIntegration !== undefined) {
      setHasAccountingIntegration(Boolean(resolvedClientInfo.client.hasAccountingIntegration));
    } else if (resolvedClientInfo?.client?.accountingTool) {
      setHasAccountingIntegration(hasActiveAccountingIntegration(resolvedClientInfo.client.accountingTool));
    }

    if (target?.crmTool !== undefined) {
      setCrmTool(target.crmTool);
    } else if (resolvedClientInfo?.client?.crmTool !== undefined) {
      setCrmTool(resolvedClientInfo.client.crmTool);
    }
    if (target?.crmDrives !== undefined) {
      setCrmDrives(target.crmDrives);
    } else if (resolvedClientInfo?.client?.crmDrives !== undefined) {
      setCrmDrives(resolvedClientInfo.client.crmDrives);
    }
  }, [target, resolvedClientInfo]);

  // Fetch job details on-demand when opened
  useEffect(() => {
    if (!isOpen) {
      setJob(null);
      setDraftEdits({});
      setError(null);
      setLoading(false);
      return;
    }

    let isMounted = true;
    let { clientSheetId } = resolvedClientInfo;

    const executeFetch = async (sheetId) => {
      setLoading(true);
      setError(null);
      setJob(null);
      setDraftEdits({});

      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_all_client_jobs",
            clientSheetId: sheetId,
            tabName: "All"
          })
        });
        const data = await res.json();
        if (!isMounted) return;

        if (data.success && Array.isArray(data.jobs)) {
          setAllJobs(data.jobs);
          if (data.productLines) setProductLines(data.productLines);
          if (data.leadSources) setLeadSources(data.leadSources);
          if (data.hasAccountingIntegration !== undefined) setHasAccountingIntegration(Boolean(data.hasAccountingIntegration));
          if (data.crmTool) setCrmTool(data.crmTool);
          if (data.crmDrives) setCrmDrives(data.crmDrives);

          const rawCode = String(target?.projectCode || "").trim().toLowerCase();
          const targetProjectCode = ["-", "n/a", "none"].includes(rawCode) ? "" : rawCode;
          const targetJobName = String(target?.jobName || "").trim().toLowerCase();
          const targetEndClient = String(target?.endClientName || (target?.client && typeof target.client === "string" ? target.client : "")).trim().toLowerCase();
          const targetRow = target?.rowNum ? Number(target.rowNum) : null;
          const targetTab = String(target?.tabName || "").trim().toLowerCase();

          let found = null;
          const tabMatches = (j) => !targetTab || String(j.tabName || "").toLowerCase() === targetTab;

          // 1. Match by Project Code (Highest fidelity, unique ID)
          if (targetProjectCode) {
            found = data.jobs.find(
              (j) => tabMatches(j) && String(j.projectCode || j.rows?.[0]?.projectCode || "").trim().toLowerCase() === targetProjectCode
            );
            if (!found) {
              found = data.jobs.find(
                (j) => String(j.projectCode || j.rows?.[0]?.projectCode || "").trim().toLowerCase() === targetProjectCode
              );
            }
          }

          // 2. Match by End Client Name + Job Name (Exact normalized)
          if (!found && targetJobName && targetEndClient) {
            const matches = data.jobs.filter((j) => {
              if (!tabMatches(j)) return false;
              const jClient = String(j.client || j.rows?.[0]?.client || "").trim().toLowerCase();
              const jJob = String(j.jobName || j.rows?.[0]?.jobName || "").trim().toLowerCase();
              return jClient === targetEndClient && jJob === targetJobName;
            });

            if (matches.length === 1) {
              found = matches[0];
            } else if (matches.length > 1) {
              // Disambiguate by row if available (e.g. multi-month retainer rows)
              if (targetRow) {
                found = matches.find((j) => (j.rows || []).some((r) => Number(r.rowNum) === targetRow)) || matches[0];
              } else {
                found = matches[0];
              }
            } else {
              const anyTabMatches = data.jobs.filter((j) => {
                const jClient = String(j.client || j.rows?.[0]?.client || "").trim().toLowerCase();
                const jJob = String(j.jobName || j.rows?.[0]?.jobName || "").trim().toLowerCase();
                return jClient === targetEndClient && jJob === targetJobName;
              });
              if (anyTabMatches.length === 1) {
                found = anyTabMatches[0];
              } else if (anyTabMatches.length > 1 && targetRow) {
                found = anyTabMatches.find((j) => (j.rows || []).some((r) => Number(r.rowNum) === targetRow)) || anyTabMatches[0];
              }
            }
          }

          // 3. Match by End Client Name + Job Name (Flexible contains / trimmed)
          if (!found && targetJobName && targetEndClient) {
            const flexMatches = data.jobs.filter((j) => {
              if (!tabMatches(j)) return false;
              const jClient = String(j.client || j.rows?.[0]?.client || "").trim().toLowerCase();
              const jJob = String(j.jobName || j.rows?.[0]?.jobName || "").trim().toLowerCase();
              const clientMatch = jClient === targetEndClient || jClient.includes(targetEndClient) || targetEndClient.includes(jClient);
              const jobMatch = jJob === targetJobName || jJob.includes(targetJobName) || targetJobName.includes(jJob);
              return clientMatch && jobMatch;
            });
            if (flexMatches.length === 1) {
              found = flexMatches[0];
            } else if (flexMatches.length > 1 && targetRow) {
              found = flexMatches.find((j) => (j.rows || []).some((r) => Number(r.rowNum) === targetRow)) || flexMatches[0];
            }
          }

          // 4. Match by Job Name alone (if unique)
          if (!found && targetJobName) {
            const jobOnlyMatches = data.jobs.filter((j) => {
              if (!tabMatches(j)) return false;
              const jJob = String(j.jobName || j.rows?.[0]?.jobName || "").trim().toLowerCase();
              return jJob === targetJobName || jJob.includes(targetJobName) || targetJobName.includes(jJob);
            });
            if (jobOnlyMatches.length === 1) {
              found = jobOnlyMatches[0];
            } else if (jobOnlyMatches.length > 1 && targetRow) {
              found = jobOnlyMatches.find((j) => (j.rows || []).some((r) => Number(r.rowNum) === targetRow));
            }
          }

          // 5. Match by row number as LAST RESORT (Fragile fallback only)
          if (!found && targetRow) {
            if (targetTab) {
              found = data.jobs.find(
                (j) =>
                  String(j.tabName || "").toLowerCase() === targetTab &&
                  (j.rows || []).some((r) => Number(r.rowNum) === targetRow)
              );
            }
            if (!found) {
              found = data.jobs.find((j) => (j.rows || []).some((r) => Number(r.rowNum) === targetRow));
            }
          }

          if (found) {
            setJob(found);
          } else {
            const desc = [
              targetProjectCode ? `[${target.projectCode}]` : null,
              targetEndClient ? targetEndClient : null,
              target.jobName ? `"${target.jobName}"` : null,
              targetRow ? `(row ${targetRow})` : null
            ].filter(Boolean).join(" ");
            setError(`Job ${desc} could not be found in the client sheet.`);
          }
        } else {
          setError(data.error || "Failed to load job details from spreadsheet.");
        }
      } catch (err) {
        if (isMounted) setError(err.message || "Failed to fetch job details.");
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    const resolveAndFetch = async () => {
      if (clientSheetId) {
        await executeFetch(clientSheetId);
        return;
      }

      // If clientSheetId wasn't in activeClientsMap and activeClientsMap is empty, try fetching all clients dynamically
      if (!activeClientsMap || Object.keys(activeClientsMap).length === 0) {
        setLoading(true);
        let dynamicSheetId = null;
        try {
          const clientsRes = await fetch("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "get_all_clients" })
          });
          const clientsData = await clientsRes.json();
          if (clientsData.success && clientsData.clientsMap) {
            if (isMounted) setInternalClientsMap(clientsData.clientsMap);
            const candidateNames = [
              target?.clientName,
              target?.client?.clientName,
              target?.client?.name,
              target?.endClientName
            ].filter(Boolean);

            for (const name of candidateNames) {
              const trimmed = String(name).trim();
              if (clientsData.clientsMap[trimmed]) {
                const matched = clientsData.clientsMap[trimmed];
                dynamicSheetId = matched.clientSheetId || matched.sheetId || null;
                break;
              }
              const lower = trimmed.toLowerCase();
              const foundKey = Object.keys(clientsData.clientsMap).find((k) => k.toLowerCase() === lower);
              if (foundKey && clientsData.clientsMap[foundKey]) {
                const matched = clientsData.clientsMap[foundKey];
                dynamicSheetId = matched.clientSheetId || matched.sheetId || null;
                break;
              }
            }
          }
        } catch (_) { }

        if (dynamicSheetId) {
          await executeFetch(dynamicSheetId);
          return;
        }
      }

      // If still no sheet ID found
      if (isMounted) {
        setLoading(false);
        setJob(null);
        setDraftEdits({});
        const name = target?.clientName || target?.client?.clientName || target?.endClientName || "this client";
        setError(`Client spreadsheet not found for "${name}". Please ensure the client has a valid Client Sheet URL configured in PMA.`);
      }
    };

    resolveAndFetch();

    return () => {
      isMounted = false;
    };
  }, [isOpen, target, resolvedClientInfo, activeClientsMap, reloadTrigger]);

  // Close on Escape key if no sub-modal is open
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape" && isOpen && !invoicesEditSlot && !directCostsEditSlot && !jobsEditSplit) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, invoicesEditSlot, directCostsEditSlot, jobsEditSplit, onClose]);

  // Job helpers
  const parentRow = job?.rows?.[0] || {};
  const tabName = job?.tabName || parentRow.tabName || target?.tabName || "Confirmed";
  const isConfirmed = tabName.toLowerCase() === "confirmed";

  const effectiveCrmTool = crmTool || resolvedClientInfo?.client?.crmTool || user?.crmTool || null;
  const effectiveCrmDrives = crmDrives || resolvedClientInfo?.client?.crmDrives || user?.crmDrives || null;
  const crmDisplayName = useMemo(() => getCrmDisplayName(effectiveCrmTool), [effectiveCrmTool]);

  const isJobFromCrm = useMemo(() => {
    if (!job) return false;
    if (isCrmDeal(job, effectiveCrmTool, effectiveCrmDrives)) return true;
    if (hasActiveCrmIntegration(effectiveCrmTool) && isCrmDrivenTab(tabName, effectiveCrmDrives)) {
      const code = String(job?.projectCode || job?.rows?.[0]?.projectCode || "").trim();
      if (code && !["-", "n/a", "none"].includes(code.toLowerCase())) return true;
      if (String(effectiveCrmDrives || "").trim().toLowerCase() === "pipeandconf") return true;
    }
    return false;
  }, [job, effectiveCrmTool, effectiveCrmDrives, tabName]);

  const isReadOnly = Boolean(target?.isReadOnly);
  const isJobLocked = Boolean(isReadOnly || isJobFromCrm);
  const lockTooltip = isJobLocked
    ? (isReadOnly ? "Read only view" : `Locked - syncing with ${crmDisplayName}`)
    : undefined;

  const lockedInputStyle = isJobLocked
    ? { backgroundColor: "#f8fafc", color: "#64748b", cursor: "not-allowed", borderColor: "#e2e8f0" }
    : {};

  if (!isOpen) return null;

  const getJobFieldValue = (fieldKey) => {
    if (draftEdits[fieldKey] !== undefined) return draftEdits[fieldKey];
    return parentRow[fieldKey] !== undefined ? parentRow[fieldKey] : "";
  };

  const handleDraftFieldChange = (fieldKey, val) => {
    if (isJobLocked) return;
    setDraftEdits((prev) => ({ ...prev, [fieldKey]: val }));
  };

  const handleDiscardChanges = () => {
    if (isJobLocked) return;
    setDraftEdits({});
  };

  const isDirty = Object.keys(draftEdits).length > 0;

  // Active values
  const clientVal = getJobFieldValue("client");
  const jobNameVal = getJobFieldValue("jobName");
  const typeVal = getJobFieldValue("projectRetainer") || "Project";
  const isRetainer = String(typeVal).toLowerCase().includes("retainer");
  const revVal = getJobFieldValue("revenue");
  const directCostsVal = getJobFieldValue("directCosts");
  const startDateVal = getJobFieldValue("startDate");
  const endDateVal = getJobFieldValue("endDate");
  const likelihoodVal = getJobFieldValue("likelihood");
  const dateConfVal = getJobFieldValue("dateConf");
  const leadSrcVal = getJobFieldValue("leadSrc");
  const prodLineVal = getJobFieldValue("prodLine");
  const vatVal = getJobFieldValue("vat") || "Yes";
  const projectCodeVal = getJobFieldValue("projectCode");
  const unevenSplitVal = getJobFieldValue("unevenSplit") || parentRow.unevenSplit || "";

  // Distinct options
  const plOptions = Array.from(new Set([...(productLines || []), prodLineVal].filter(Boolean))).sort();
  const lsOptions = Array.from(new Set([...(leadSources || []), leadSrcVal].filter(Boolean))).sort();

  // Financial metrics
  const getJobFinancialMetrics = () => {
    if (!job || !job.rows || job.rows.length === 0) {
      return { revenue: 0, realInvoiced: 0, placeholderInvoiced: 0, leftToInvoice: 0, directCosts: 0, realCostsReceived: 0, placeholderCosts: 0, costsLeftToReceive: 0 };
    }

    const rawRev = parseFloat(String(revVal !== undefined ? revVal : (parentRow.revenue || "0")).replace(/[£$€,\s]/g, "")) || 0;
    const rawCost = parseFloat(String(directCostsVal !== undefined ? directCostsVal : (parentRow.directCosts || "0")).replace(/[£$€,\s]/g, "")) || 0;

    let realInvoiced = 0;
    let placeholderInvoiced = 0;
    job.rows.forEach((r) => {
      (r.invoiceSlots || []).forEach((slot) => {
        const amt = parseFloat(String(slot.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
        if (amt > 0) {
          const ref = String(slot.ref || "").trim();
          if (isPlaceholderInvoice(ref, slot.status) || !ref) {
            placeholderInvoiced += amt;
          } else {
            realInvoiced += amt;
          }
        }
      });
    });

    let realCostsReceived = 0;
    let placeholderCosts = 0;
    job.rows.forEach((r) => {
      (r.expenseSlots || []).forEach((slot) => {
        const amt = parseFloat(String(slot.amount || "0").replace(/[£$€,\s]/g, "")) || 0;
        if (amt > 0) {
          if (isPlaceholderExpense(slot)) {
            placeholderCosts += amt;
          } else {
            realCostsReceived += amt;
          }
        }
      });
    });

    let totalRevenue = rawRev;
    let totalDirectCosts = rawCost;
    let leftToInvoice = 0;
    let costsLeftToReceive = 0;

    if (!isConfirmed) {
      leftToInvoice = 0;
      costsLeftToReceive = 0;
    } else if (isRetainer) {
      const now = new Date();
      let baseStartDate = parseSheetDate(parentRow.startDate) || parseSheetDate(parentRow.dateConf);
      const sDate = baseStartDate || parseSheetDate(parentRow.startDate);
      const eDate = parseSheetDate(parentRow.endDate);
      let monthsCount = job.rows.length;
      if (sDate && eDate && eDate > sDate) {
        const diffDays = (eDate.getTime() - sDate.getTime()) / (24 * 60 * 60 * 1000);
        monthsCount = Math.max(job.rows.length, Math.round(diffDays / 30.4375));
      }
      totalRevenue = rawRev * monthsCount;
      totalDirectCosts = rawCost * monthsCount;

      if (sDate) {
        let expectedPriorRevenue = 0;
        let expectedPriorCosts = 0;
        for (let p = 0; p < monthsCount; p++) {
          const nextPStart = addMonths(sDate, p + 1);
          const pEnd = new Date(nextPStart.getFullYear(), nextPStart.getMonth(), nextPStart.getDate() - 1, 23, 59, 59, 999);
          if (pEnd < now) {
            const periodRev = job.rows[p]?.revenue ? (parseFloat(String(job.rows[p].revenue).replace(/[£$€,\s]/g, "")) || rawRev) : rawRev;
            expectedPriorRevenue += periodRev;
            const periodCost = job.rows[p]?.directCosts ? (parseFloat(String(job.rows[p].directCosts).replace(/[£$€,\s]/g, "")) || rawCost) : rawCost;
            expectedPriorCosts += periodCost;
          }
        }
        leftToInvoice = Math.max(0, expectedPriorRevenue - realInvoiced);
        costsLeftToReceive = Math.max(0, expectedPriorCosts - realCostsReceived);
      }
    } else {
      leftToInvoice = totalRevenue > 0 ? Math.max(0, totalRevenue - realInvoiced) : 0;
      costsLeftToReceive = totalDirectCosts > 0 ? Math.max(0, totalDirectCosts - realCostsReceived) : 0;
    }

    return {
      revenue: totalRevenue,
      realInvoiced,
      placeholderInvoiced,
      leftToInvoice,
      directCosts: totalDirectCosts,
      realCostsReceived,
      placeholderCosts,
      costsLeftToReceive
    };
  };

  const metrics = getJobFinancialMetrics();

  // Gather invoice slots
  const getJobInvoiceItems = () => {
    if (!job || !job.rows || job.rows.length === 0) return [];
    const items = [];
    if (isRetainer) {
      job.rows.forEach((r, rIdx) => {
        const monthLabel = getRetainerRowMonthLabel(r, rIdx, job);
        const slots = r.invoiceSlots || [];
        slots.forEach((s) => {
          const hasRef = Boolean(s.ref && String(s.ref).trim() !== "");
        const hasAmt = Boolean(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        const hasData = hasRef || hasAmt;
          if (hasData) {
            const isPartPaid = String(s.status || "").toLowerCase().includes("part");
            const isPlace = isPlaceholderInvoice(s.ref, s.status);
            const extraRef = s.ref && String(s.ref).trim() !== ""
              ? `#${String(s.ref).trim()}`
              : (isPlace ? "Placeholder" : (isPartPaid ? "Part payment" : monthLabel));
            items.push({
              id: `ret_inv_${r.rowNum}_${s.slotNum}`,
              rowNum: r.rowNum,
              slotNum: s.slotNum,
              slot: s,
              row: r,
              label: extraRef,
              subLabel: s.sentDate ? `${s.sentDate}` : ""
            });
          }
        });
      });
    } else {
      job.rows.forEach((r) => {
        const slots = r.invoiceSlots || [];
        slots.forEach((s) => {
          const hasRef = Boolean(s.ref && String(s.ref).trim() !== "");
        const hasAmt = Boolean(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        const hasData = hasRef || hasAmt;
          if (hasData) {
            const isPlace = isPlaceholderInvoice(s.ref, s.status);
            const refStr = s.ref && String(s.ref).trim() !== ""
              ? `#${String(s.ref).trim()}`
              : (isPlace ? "Placeholder" : "Invoice");
            items.push({
              id: `proj_inv_${r.rowNum}_${s.slotNum}`,
              rowNum: r.rowNum,
              slotNum: s.slotNum,
              slot: s,
              row: r,
              label: refStr,
              subLabel: ""
            });
          }
        });
      });
    }
    return items;
  };

  // Gather direct cost slots
  const getJobExpenseItems = () => {
    if (!job || !job.rows || job.rows.length === 0) return [];
    const items = [];
    if (isRetainer) {
      job.rows.forEach((r, rIdx) => {
        const monthLabel = getRetainerRowMonthLabel(r, rIdx, job);
        const slots = r.expenseSlots || [];
        slots.forEach((s) => {
          const hasDesc = Boolean(s.description && String(s.description).trim() !== "");
        const hasAmt = Boolean(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        const hasTx = Boolean(s.transactionId && String(s.transactionId).trim() !== "");
        const hasData = hasDesc || hasAmt || hasTx;
          if (hasData) {
            const expLabel = s.description && String(s.description).trim() !== ""
              ? String(s.description).trim()
              : (s.transactionId && String(s.transactionId).trim() !== ""
                  ? `#${String(s.transactionId).trim()}`
                  : (isPlaceholderExpense(s) ? "Placeholder" : `${monthLabel} direct cost`));
            items.push({
              id: `ret_exp_${r.rowNum}_${s.slotNum}`,
              rowNum: r.rowNum,
              slotNum: s.slotNum,
              slot: s,
              row: r,
              label: expLabel,
              subLabel: ""
            });
          }
        });
      });
    } else {
      job.rows.forEach((r) => {
        const slots = r.expenseSlots || [];
        slots.forEach((s) => {
          const hasDesc = Boolean(s.description && String(s.description).trim() !== "");
        const hasAmt = Boolean(s.amount && parseFloat(String(s.amount).replace(/[£$€,\s]/g, "")) > 0);
        const hasTx = Boolean(s.transactionId && String(s.transactionId).trim() !== "");
        const hasData = hasDesc || hasAmt || hasTx;
          if (hasData) {
            const expLabel = s.description && String(s.description).trim() !== ""
              ? String(s.description).trim()
              : (s.transactionId && String(s.transactionId).trim() !== ""
                  ? `#${String(s.transactionId).trim()}`
                  : (isPlaceholderExpense(s) ? "Placeholder" : "Direct cost"));
            items.push({
              id: `proj_exp_${r.rowNum}_${s.slotNum}`,
              rowNum: r.rowNum,
              slotNum: s.slotNum,
              slot: s,
              row: r,
              label: expLabel,
              subLabel: ""
            });
          }
        });
      });
    }
    return items;
  };

  const handleAddNewInvoicePlaceholder = () => {
    if (!job) return;
    const parentRow = job.rows?.[0] || job;
    let targetRowNum = null;
    let targetSlotNum = null;
    let createNewRow = false;

    for (const r of (job.rows || [])) {
      const slots = r.invoiceSlots || [];
      for (let sNum = 1; sNum <= 3; sNum++) {
        const existing = slots.find((s) => s.slotNum === sNum);
        const isOccupied = existing && Boolean(
          (existing.ref && String(existing.ref).trim() !== "") ||
          (existing.amount && String(existing.amount).trim() !== "") ||
          isPlaceholderInvoice(existing.ref, existing.status)
        );
        if (!isOccupied) {
          targetRowNum = r.rowNum;
          targetSlotNum = sNum;
          break;
        }
      }
      if (targetRowNum) break;
    }

    if (!targetRowNum) {
      const lastRow = job.rows?.[job.rows.length - 1];
      targetRowNum = lastRow ? lastRow.rowNum : (job.rowNum || 2);
      targetSlotNum = 1;
      createNewRow = true;
    }

    const defaultAmt = metrics.leftToInvoice > 0 ? String(metrics.leftToInvoice) : "";
    const defaultRef = generatePlaceholderInvoiceRef(new Date().toISOString().slice(0, 10));

    setInvoicesEditSlot({
      rowNum: targetRowNum,
      slotNum: targetSlotNum,
      createNewRow,
      isNewPlaceholder: true,
      slot: {
        ref: defaultRef,
        amount: defaultAmt,
        status: "Placeholder",
        sentDate: "",
        daysToPay: 30
      },
      jobClient: parentRow.client || job.client,
      jobName: parentRow.jobName || job.jobName,
      slotLabel: "New placeholder",
      tabName,
      job
    });
  };

  const handleAddNewExpensePlaceholder = () => {
    if (!job) return;
    const parentRow = job.rows?.[0] || job;
    let targetRowNum = null;
    let targetSlotNum = null;
    let createNewRow = false;

    for (const r of (job.rows || [])) {
      const slots = r.expenseSlots || [];
      for (let sNum = 1; sNum <= 3; sNum++) {
        const existing = slots.find((s) => s.slotNum === sNum);
        const isOccupied = existing && Boolean(
          (existing.description && String(existing.description).trim() !== "") ||
          (existing.amount && String(existing.amount).trim() !== "") ||
          (existing.transactionId && String(existing.transactionId).trim() !== "") ||
          isPlaceholderExpense(existing)
        );
        if (!isOccupied) {
          targetRowNum = r.rowNum;
          targetSlotNum = sNum;
          break;
        }
      }
      if (targetRowNum) break;
    }

    if (!targetRowNum) {
      const lastRow = job.rows?.[job.rows.length - 1];
      targetRowNum = lastRow ? lastRow.rowNum : (job.rowNum || 2);
      targetSlotNum = 1;
      createNewRow = true;
    }

    const defaultAmt = metrics.costsLeftToReceive > 0 ? String(metrics.costsLeftToReceive) : "";
    const defaultDesc = "Direct cost placeholder";

    setDirectCostsEditSlot({
      rowNum: targetRowNum,
      slotNum: targetSlotNum,
      createNewRow,
      isNewPlaceholder: true,
      slot: {
        description: defaultDesc,
        amount: defaultAmt,
        vat: "Yes",
        date: "",
        daysToPay: 30,
        status: "Placeholder",
        transactionId: ""
      },
      jobName: parentRow.jobName || job.jobName,
      jobClient: parentRow.client || job.client,
      slotLabel: "New placeholder",
      tabName
    });
  };

  const invoiceItems = groupSlotItemsForDisplay(getJobInvoiceItems(), "invoice");
  const expenseItems = groupSlotItemsForDisplay(getJobExpenseItems(), "expense");

  const getStatusPill = (status) => {
    const s = String(status || "").trim();
    const lower = s.toLowerCase();
    if (lower === "paid") return { backgroundColor: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
    if (lower === "draft") return { backgroundColor: "#ffedd5", color: "#9a3412", border: "1px solid #fed7aa" };
    if (lower === "sent" || lower === "received") return { backgroundColor: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" };
    if (lower.includes("part-paid") || lower.includes("part paid") || lower.includes("partpaid")) {
      return { backgroundColor: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" };
    }
    return { backgroundColor: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
  };

  const openJobNoteModal = () => {
    if (!job) return;
    const currentNote = job.note || parentRow.note || "";
    setCellNoteModalConfig({
      isOpen: true,
      title: "Job note",
      subtitle: `${clientVal || job.client || ""} · ${jobNameVal || job.jobName || ""} (${tabName} Row ${parentRow.rowNum})`,
      initialNote: currentNote,
      tabName,
      sheetRow: parentRow.rowNum,
      colLetter: "A",
      onSaveSuccess: (savedNote) => {
        setJob((prev) => {
          if (!prev) return prev;
          const updatedRows = (prev.rows || []).map((r, rIdx) =>
            rIdx === 0 ? { ...r, note: savedNote } : r
          );
          return { ...prev, note: savedNote, rows: updatedRows };
        });
      }
    });
  };

  const openSlotNoteModal = ({ item, type }) => {
    if (!job) return;
    const rowNum = item.rowNum;
    const slotNum = item.slotNum;
    const currentTab = item.row?.tabName || tabName || "Confirmed";
    const colLetter = type === "invoice"
      ? (slotNum === 1 ? "AP" : slotNum === 2 ? "AW" : "BD")
      : (slotNum === 1 ? "BX" : slotNum === 2 ? "CE" : "CL");
    const currentNote = item.slot?.note || "";

    const invRefDisplay = item.slot?.ref ? `#${item.slot.ref}` : (item.label || "Invoice");
    setCellNoteModalConfig({
      isOpen: true,
      title: type === "invoice" ? `Invoice note (${invRefDisplay})` : `Direct cost note (${item.label})`,
      subtitle: `${clientVal || job.client || ""} · ${jobNameVal || job.jobName || ""} (${currentTab} Row ${rowNum})`,
      initialNote: currentNote,
      tabName: currentTab,
      sheetRow: rowNum,
      colLetter,
      onSaveSuccess: (savedNote) => {
        setJob((prev) => {
          if (!prev) return prev;
          const updatedRows = (prev.rows || []).map((r) => {
            if (r.rowNum === rowNum) {
              if (type === "invoice") {
                const nextInvoiceSlots = (r.invoiceSlots || []).map((s) =>
                  s.slotNum === slotNum ? { ...s, note: savedNote } : s
                );
                return { ...r, invoiceSlots: nextInvoiceSlots };
              } else {
                const nextExpenseSlots = (r.expenseSlots || []).map((s) =>
                  s.slotNum === slotNum ? { ...s, note: savedNote } : s
                );
                return { ...r, expenseSlots: nextExpenseSlots };
              }
            }
            return r;
          });
          return { ...prev, rows: updatedRows };
        });
      }
    });
  };

  const handleSaveCellNote = async (newNote) => {
    const { clientSheetId, client } = resolvedClientInfo;
    if (!cellNoteModalConfig || !clientSheetId) return;
    const { tabName: noteTab, sheetRow, colLetter, onSaveSuccess } = cellNoteModalConfig;
    const res = await fetch("/api/triage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_cell_note",
        clientSheetId,
        clientName: client?.clientName || target?.clientName || "",
        tab: noteTab,
        sheetRow,
        colLetter,
        note: newNote,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || "Failed to update cell note");
    }
    if (onSaveSuccess) onSaveSuccess(newNote);
    setRecentlySaved(true);
    setTimeout(() => setRecentlySaved(false), 3000);
  };

  // Save changes handler
  const handleSaveJob = async () => {
    if (isJobLocked) return;
    const { clientSheetId, client } = resolvedClientInfo;
    if (!job || !isDirty || !clientSheetId) return;

    const parentRowNum = parentRow.rowNum;
    const FIELD_MAP = {
      client: { colLetter: "A", fieldName: "Client" },
      jobName: { colLetter: "B", fieldName: "Job Name" },
      projectCode: { colLetter: "C", fieldName: "Project Code" },
      dateConf: { colLetter: "D", fieldName: tabName === "Pipeline" ? "Date Added" : "Date Confirmed", isDate: true },
      leadSrc: { colLetter: "E", fieldName: "Lead Source" },
      revenue: { colLetter: "AG", fieldName: "Revenue" },
      directCosts: { colLetter: "AH", fieldName: "Direct Costs" },
      vat: { colLetter: "AI", fieldName: "VAT" },
      projectRetainer: { colLetter: "AJ", fieldName: "Type" },
      prodLine: { colLetter: "AK", fieldName: "Product Line" },
      startDate: { colLetter: "AL", fieldName: "Start Date", isDate: true },
      endDate: { colLetter: "AM", fieldName: "End Date", isDate: true },
      likelihood: { colLetter: "AN", fieldName: "Likelihood" }
    };

    const updates = [];
    Object.keys(draftEdits).forEach((f) => {
      const meta = FIELD_MAP[f];
      if (!meta) return;
      let val = draftEdits[f];
      if (meta.isDate && val) val = toSheetDateFormat(val);
      updates.push({
        colLetter: meta.colLetter,
        rowNum: parentRowNum,
        cellRef: `${meta.colLetter}${parentRowNum}`,
        fieldName: meta.fieldName,
        value: val
      });

      if ((f === "client" || f === "jobName") && job.rows && job.rows.length > 1) {
        job.rows.slice(1).forEach((childRow) => {
          updates.push({
            colLetter: meta.colLetter,
            rowNum: childRow.rowNum,
            cellRef: `${meta.colLetter}${childRow.rowNum}`,
            fieldName: meta.fieldName,
            value: val
          });
        });
      }
    });

    if (updates.length === 0) return;

    setSaving(true);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_job_fields",
          clientSheetId,
          clientName: client?.clientName || target?.clientName || "",
          tabName,
          rowNum: parentRowNum,
          endClientName: draftEdits.client || parentRow.client || job.client,
          jobName: draftEdits.jobName || parentRow.jobName || job.jobName,
          updates
        })
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to update job");

      // Update local state
      setJob((prev) => {
        if (!prev) return prev;
        const updatedRows = prev.rows.map((r, rIdx) => {
          const nextRow = { ...r };
          Object.keys(draftEdits).forEach((f) => {
            let nextVal = draftEdits[f];
            if (FIELD_MAP[f]?.isDate && nextVal) nextVal = toSheetDateFormat(nextVal);
            if (rIdx === 0 || f === "client" || f === "jobName") nextRow[f] = nextVal;
          });
          return nextRow;
        });
        return {
          ...prev,
          client: draftEdits.client || prev.client,
          jobName: draftEdits.jobName || prev.jobName,
          projectCode: draftEdits.projectCode !== undefined ? draftEdits.projectCode : prev.projectCode,
          rows: updatedRows
        };
      });

      setDraftEdits({});
      setRecentlySaved(true);
      setTimeout(() => setRecentlySaved(false), 3000);
    } catch (err) {
      alert("Error saving job: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {/* Sub-modals */}
      {invoicesEditSlot && (
        <InvoicesEditModal
          editSlot={invoicesEditSlot}
          invoicesClient={resolvedClientInfo.client || target.client}
          availableJobs={allJobs}
          hasAccountingIntegration={
            hasAccountingIntegration ||
            Boolean(resolvedClientInfo?.client?.hasAccountingIntegration) ||
            Boolean(target?.hasAccountingIntegration) ||
            Boolean(target?.client?.hasAccountingIntegration) ||
            hasActiveAccountingIntegration(resolvedClientInfo?.client?.accountingTool || target?.client?.accountingTool)
          }
          onClose={() => setInvoicesEditSlot(null)}
          onMarkPullPending={(masterId) => onMarkPullPending && onMarkPullPending(masterId)}
          onInvoiceMoved={() => setReloadTrigger((prev) => prev + 1)}
          onUpdateInvoiceJobs={(rNum, sNum, newData, resData) => {
            if (invoicesEditSlot?.createNewRow) {
              setReloadTrigger((prev) => prev + 1);
              return;
            }
            setRecentlySaved(true);
            setTimeout(() => setRecentlySaved(false), 3000);
            setJob((prev) => {
              if (!prev) return prev;
              let updated = { ...prev };
              if (resData?.placeholderAdjustment) {
                const { rowNum: pRow, slotNum: pSlot, newAmount: pAmt } = resData.placeholderAdjustment;
                updated.rows = updated.rows.map(r => {
                  if (r.rowNum === pRow) {
                    return {
                      ...r,
                      invoiceSlots: (r.invoiceSlots || []).map(sl =>
                        sl.slotNum === pSlot ? { ...sl, amount: pAmt > 0 ? String(pAmt) : "" } : sl
                      )
                    };
                  }
                  return r;
                });
              }
              if (resData?.updatedRevenue !== undefined) {
                updated.revenue = resData.updatedRevenue;
                updated.rows = updated.rows.map(r => ({ ...r, revenue: resData.updatedRevenue }));
              }
              return {
                ...updated,
                rows: updated.rows.map((r) =>
                  r.rowNum !== rNum
                    ? r
                    : {
                      ...r,
                      invoiceSlots: (r.invoiceSlots || []).map((sl) => (sl.slotNum !== sNum ? sl : { ...sl, ...newData }))
                    }
                )
              };
            });
          }}
        />
      )}

      {directCostsEditSlot && (
        <DirectCostsEditModal
          editSlot={directCostsEditSlot}
          client={resolvedClientInfo.client || target.client}
          onClose={() => setDirectCostsEditSlot(null)}
          onMarkPullPending={(masterId) => onMarkPullPending && onMarkPullPending(masterId)}
          onUpdateJobs={(rNum, sNum, newData) => {
            if (directCostsEditSlot?.createNewRow) {
              setReloadTrigger((prev) => prev + 1);
              return;
            }
            setRecentlySaved(true);
            setTimeout(() => setRecentlySaved(false), 3000);
            setJob((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                rows: prev.rows.map((r) =>
                  r.rowNum !== rNum
                    ? r
                    : {
                      ...r,
                      expenseSlots: (r.expenseSlots || []).map((sl) => (sl.slotNum !== sNum ? sl : { ...sl, ...newData }))
                    }
                )
              };
            });
          }}
        />
      )}

      {jobsEditSplit && (
        <UnevenSplitModal
          editSplit={jobsEditSplit}
          client={resolvedClientInfo.client || target.client}
          tabName={jobsEditSplit.tabName || tabName}
          onClose={() => setJobsEditSplit(null)}
          onUpdateJobsData={(rNum, splitStr, updatedFields) => {
            setRecentlySaved(true);
            setTimeout(() => setRecentlySaved(false), 3000);
            setJob((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                rows: prev.rows.map((r) => {
                  if (r.rowNum === rNum) {
                    const updatedRow = { ...r, unevenSplit: splitStr };
                    if (updatedFields?.startDate) updatedRow.startDate = toSheetDateFormat(updatedFields.startDate);
                    if (updatedFields?.endDate) updatedRow.endDate = toSheetDateFormat(updatedFields.endDate);
                    if (updatedFields?.revenue !== undefined) updatedRow.revenue = updatedFields.revenue;
                    return updatedRow;
                  }
                  return r;
                })
              };
            });
          }}
        />
      )}

      {cellNoteModalConfig && (
        <CellNoteModal
          isOpen={cellNoteModalConfig.isOpen}
          title={cellNoteModalConfig.title}
          subtitle={cellNoteModalConfig.subtitle}
          initialNote={cellNoteModalConfig.initialNote}
          onSave={handleSaveCellNote}
          onClose={() => setCellNoteModalConfig(null)}
        />
      )}

      {/* Main Modal Overlay */}
      <div
        className="job-detail-modal-overlay"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.65)",
          zIndex: 1100,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "20px"
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !invoicesEditSlot && !directCostsEditSlot && !jobsEditSplit) {
            onClose();
          }
        }}
      >
        <div
          className="job-detail-modal-card"
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            width: "min(96vw, 1340px)",
            maxHeight: "92vh",
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 25px 50px -12px rgba(0,0,0,0.35)",
            overflow: "hidden"
          }}
        >
          {/* Header */}
          <div
            className="job-detail-modal-header"
            style={{
              padding: "16px 24px",
              borderBottom: "1px solid #e2e8f0",
              background: "#ffffff",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "12px"
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <span
                  style={{
                    padding: "3px 9px",
                    borderRadius: "12px",
                    fontSize: "12px",
                    fontWeight: "700",
                    background: isConfirmed ? "#dcfce7" : "#e0f2fe",
                    color: isConfirmed ? "#15803d" : "#0369a1",
                    border: isConfirmed ? "1px solid #bbf7d0" : "1px solid #bae6fd",
                    whiteSpace: "nowrap"
                  }}
                >
                  {isConfirmed ? "Confirmed job" : "Pipeline job"}
                </span>
                {isJobFromCrm && <CrmSyncBadge crmDisplayName={crmDisplayName} />}
                <h2 style={{ margin: 0, fontSize: "17px", fontWeight: "700", color: "#0f172a", wordBreak: "break-word" }}>
                  {clientVal || target?.endClientName || target?.client?.clientName || "Client"}
                  {" · "}
                  <span style={{ color: "#334155", fontWeight: "600" }}>
                    {jobNameVal || target?.jobName || "Job details"}
                  </span>
                </h2>
                {projectCodeVal && (
                  <span style={{ fontSize: "12px", background: "#f1f5f9", color: "#475569", padding: "2px 8px", borderRadius: "4px", border: "1px solid #e2e8f0", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                    {projectCodeVal}
                  </span>
                )}
                {parentRow.rowNum && (
                  <span style={{ fontSize: "12px", color: "#64748b", whiteSpace: "nowrap" }}>
                    ({tabName} Row {parentRow.rowNum}{job?.rows?.length > 1 ? `-${job.rows[job.rows.length - 1].rowNum}` : ""})
                  </span>
                )}
                <NoteIndicatorButton
                  note={job?.note || parentRow?.note || ""}
                  onClick={openJobNoteModal}
                  title={job?.note || parentRow?.note ? `Job note: ${job?.note || parentRow?.note}` : "Add note to job"}
                />
              </div>

              {isJobFromCrm && (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "12px",
                    color: "#475569",
                    background: "#f1f5f9",
                    padding: "3px 9px",
                    borderRadius: "6px",
                    border: "1px solid #e2e8f0",
                    width: "fit-content",
                    marginTop: "2px"
                  }}
                >
                  <CrmSyncIcon size={13} color="#475569" strokeWidth={2.2} />
                  <span>This job is synced with {crmDisplayName || "CRM"} and core details are locked.</span>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close"
              style={{
                background: "transparent",
                border: "none",
                borderRadius: "6px",
                width: "32px",
                height: "32px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "18px",
                color: "#64748b",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.15s ease, color 0.15s ease"
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "#f1f5f9";
                e.currentTarget.style.color = "#0f172a";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
                e.currentTarget.style.color = "#64748b";
              }}
            >
              ✕
            </button>
          </div>

          {/* Body Content */}
          <div className="job-detail-modal-body" style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
            {loading && (
              <div style={{ padding: "60px 0", textAlign: "center", color: "#64748b" }}>
                <Spinner size={24} color="#0284c7" />
                <div style={{ marginTop: "12px", fontSize: "14px", fontWeight: "500" }}>
                  Loading job details…
                </div>
              </div>
            )}

            {!loading && error && (
              <div
                style={{
                  padding: "24px",
                  background: "#fef2f2",
                  border: "1px solid #fecaca",
                  borderRadius: "8px",
                  color: "#991b1b",
                  fontSize: "14px"
                }}
              >
                <div style={{ fontWeight: "700", marginBottom: "6px" }}>Could not load job details</div>
                <div>{error}</div>
                <div style={{ marginTop: "16px", display: "flex", gap: "10px" }}>
                  <button
                    type="button"
                    onClick={onClose}
                    style={{
                      padding: "6px 14px",
                      background: "#ffffff",
                      border: "1px solid #cbd5e1",
                      borderRadius: "6px",
                      fontSize: "13px",
                      fontWeight: "600",
                      cursor: "pointer"
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            )}

            {!loading && !error && job && (
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                {/* Main Job Row Summary Inputs */}
                <div
                  style={{
                    background: "#ffffff",
                    borderRadius: "8px",
                    border: "1px solid #e2e8f0",
                    padding: "16px",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.03)"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                    <div style={{ fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.04em", color: "#64748b" }}>
                      Primary Job Fields
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>Job note:</span>
                      <NoteIndicatorButton
                        size="sm"
                        note={job?.note || parentRow?.note || ""}
                        onClick={openJobNoteModal}
                        title={job?.note || parentRow?.note ? `Job note: ${job?.note || parentRow?.note}` : "Add note to job"}
                      />
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px" }}>
                    {/* Client Name */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Client</label>
                      <input
                        type="text"
                        value={clientVal}
                        onChange={(e) => handleDraftFieldChange("client", e.target.value)}
                        disabled={isJobLocked}
                        readOnly={isJobLocked}
                        title={lockTooltip}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.client !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", fontWeight: "600", outline: "none", boxSizing: "border-box",
                          ...lockedInputStyle
                        }}
                      />
                    </div>

                    {/* Job Name */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Job Name</label>
                      <input
                        type="text"
                        value={jobNameVal}
                        onChange={(e) => handleDraftFieldChange("jobName", e.target.value)}
                        disabled={isJobLocked}
                        readOnly={isJobLocked}
                        title={lockTooltip}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.jobName !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", fontWeight: "500", outline: "none", boxSizing: "border-box",
                          ...lockedInputStyle
                        }}
                      />
                    </div>

                    {/* Job Type */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Type</label>
                      <select
                        value={isRetainer ? "Retainer" : "Project"}
                        onChange={(e) => handleDraftFieldChange("projectRetainer", e.target.value)}
                        disabled={isJobLocked}
                        title={lockTooltip}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.projectRetainer !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", fontWeight: "600",
                          background: isJobLocked ? "#f8fafc" : (isRetainer ? "#e0f2fe" : "#f3e8ff"),
                          color: isJobLocked ? "#64748b" : (isRetainer ? "#0284c7" : "#7e22ce"),
                          cursor: isJobLocked ? "not-allowed" : "pointer",
                          outline: "none", boxSizing: "border-box"
                        }}
                      >
                        <option value="Project">Project</option>
                        <option value="Retainer">Retainer</option>
                      </select>
                    </div>

                    {/* Revenue */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Revenue</label>
                      <input
                        type="text"
                        value={revVal}
                        onChange={(e) => handleDraftFieldChange("revenue", e.target.value)}
                        disabled={isJobLocked}
                        readOnly={isJobLocked}
                        title={lockTooltip}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.revenue !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", fontWeight: "600", outline: "none", boxSizing: "border-box",
                          ...lockedInputStyle
                        }}
                      />
                      {isConfirmed && metrics.revenue > 0 && (
                        metrics.leftToInvoice > 0 ? (
                          <div style={{ marginTop: "4px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "6px", fontWeight: "600", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                              Left to inv: {formatCurrency(metrics.leftToInvoice)}
                            </span>
                          </div>
                        ) : (
                          <div style={{ marginTop: "4px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "6px", fontWeight: "600", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
                              ✓ Invoiced
                            </span>
                          </div>
                        )
                      )}
                    </div>

                    {/* Direct Costs */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Direct Costs</label>
                      <input
                        type="text"
                        value={directCostsVal}
                        onChange={(e) => handleDraftFieldChange("directCosts", e.target.value)}
                        disabled={isJobLocked}
                        readOnly={isJobLocked}
                        title={lockTooltip}
                        style={{
                          width: "100%", padding: "6px 8px", borderRadius: "5px",
                          border: draftEdits.directCosts !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                          fontSize: "13px", color: isJobLocked ? "#64748b" : "#475569", outline: "none", boxSizing: "border-box",
                          ...lockedInputStyle
                        }}
                      />
                      {isConfirmed && metrics.directCosts > 0 && (
                        metrics.costsLeftToReceive > 0 ? (
                          <div style={{ marginTop: "4px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "6px", fontWeight: "600", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                              Left to rec: {formatCurrency(metrics.costsLeftToReceive)}
                            </span>
                          </div>
                        ) : (
                          <div style={{ marginTop: "4px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "6px", fontWeight: "600", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
                              ✓ Received
                            </span>
                          </div>
                        )
                      )}
                    </div>

                    {/* Start Date */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Start Date</label>
                      <JobDateInput
                        value={startDateVal}
                        onChange={(val) => handleDraftFieldChange("startDate", val)}
                        isDirty={draftEdits.startDate !== undefined}
                        disabled={isJobLocked}
                        readOnly={isJobLocked}
                        title={lockTooltip}
                        defaultBorder={isJobLocked ? "1px solid #e2e8f0" : "1px solid #cbd5e1"}
                        defaultBg={isJobLocked ? "#f8fafc" : "#ffffff"}
                        style={{
                          width: "100%", padding: "6px 8px", boxSizing: "border-box",
                          ...(isJobLocked ? { cursor: "not-allowed", color: "#64748b" } : {})
                        }}
                      />
                    </div>

                    {/* End Date */}
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>End Date</label>
                      <JobDateInput
                        value={endDateVal}
                        onChange={(val) => handleDraftFieldChange("endDate", val)}
                        isDirty={draftEdits.endDate !== undefined}
                        disabled={isJobLocked}
                        readOnly={isJobLocked}
                        title={lockTooltip}
                        defaultBorder={isJobLocked ? "1px solid #e2e8f0" : "1px solid #cbd5e1"}
                        defaultBg={isJobLocked ? "#f8fafc" : "#ffffff"}
                        style={{
                          width: "100%", padding: "6px 8px", boxSizing: "border-box",
                          ...(isJobLocked ? { cursor: "not-allowed", color: "#64748b" } : {})
                        }}
                      />
                    </div>

                    {/* % Likelihood - Only for Pipeline jobs */}
                    {!isConfirmed && (
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>Likelihood</label>
                        <input
                          type="text"
                          value={likelihoodVal !== undefined && likelihoodVal !== "" ? likelihoodVal : ""}
                          onChange={(e) => handleDraftFieldChange("likelihood", e.target.value)}
                          disabled={isJobLocked}
                          readOnly={isJobLocked}
                          title={isJobLocked ? lockTooltip : undefined}
                          style={{
                            width: "100%", padding: "6px 8px", borderRadius: "5px",
                            border: draftEdits.likelihood !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                            fontSize: "13px", fontWeight: "600",
                            color: isJobLocked ? "#64748b" : "#0369a1",
                            backgroundColor: isJobLocked ? "#f8fafc" : "#ffffff",
                            cursor: isJobLocked ? "not-allowed" : "text",
                            outline: "none", boxSizing: "border-box"
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Sub-grid of 3 Expanded Cards */}
                <div className="job-detail-cards-grid" style={{ gap: "16px" }}>
                  {/* Card 1: Additional Job Information */}
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: "8px",
                      border: "1px solid #e2e8f0",
                      padding: "16px",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                    }}
                  >
                    <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                      Additional Information
                    </div>

                    <div className="job-detail-addl-info-grid" style={{ gap: "10px" }}>
                      {/* Date Confirmed */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          {isConfirmed ? "Date Confirmed" : "Date Added"}
                        </label>
                        <JobDateInput
                          value={dateConfVal}
                          onChange={(val) => handleDraftFieldChange("dateConf", val)}
                          isDirty={draftEdits.dateConf !== undefined}
                          disabled={isJobLocked}
                          readOnly={isJobLocked}
                          title={lockTooltip}
                          defaultBorder={isJobLocked ? "1px solid #e2e8f0" : "1px solid #cbd5e1"}
                          defaultBg={isJobLocked ? "#f8fafc" : "#ffffff"}
                          style={{
                            width: "100%", padding: "5px 7px", boxSizing: "border-box",
                            ...(isJobLocked ? { cursor: "not-allowed", color: "#64748b" } : {})
                          }}
                        />
                      </div>

                      {/* Project Code */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          Project Code
                        </label>
                        <input
                          type="text"
                          value={projectCodeVal || ""}
                          onChange={(e) => handleDraftFieldChange("projectCode", e.target.value)}
                          placeholder="e.g. PRJ-2026-01"
                          disabled={isJobLocked}
                          readOnly={isJobLocked}
                          title={lockTooltip}
                          style={{
                            width: "100%", padding: "5px 7px", borderRadius: "5px",
                            border: draftEdits.projectCode !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                            fontSize: "12px", outline: "none", boxSizing: "border-box",
                            ...lockedInputStyle
                          }}
                        />
                      </div>

                      {/* Lead Source */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          Lead Source
                        </label>
                        <select
                          value={leadSrcVal || ""}
                          onChange={(e) => handleDraftFieldChange("leadSrc", e.target.value)}
                          disabled={isJobLocked}
                          title={lockTooltip}
                          style={{
                            width: "100%", padding: "5px 7px", borderRadius: "5px",
                            border: draftEdits.leadSrc !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                            fontSize: "12px", outline: "none",
                            background: isJobLocked ? "#f8fafc" : "#ffffff",
                            color: isJobLocked ? "#64748b" : "#0f172a",
                            cursor: isJobLocked ? "not-allowed" : "pointer",
                            boxSizing: "border-box"
                          }}
                        >
                          <option value="">Select Lead Source...</option>
                          {lsOptions.map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      </div>

                      {/* Product Line */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          Product Line
                        </label>
                        <select
                          value={prodLineVal || ""}
                          onChange={(e) => handleDraftFieldChange("prodLine", e.target.value)}
                          disabled={isJobLocked}
                          title={lockTooltip}
                          style={{
                            width: "100%", padding: "5px 7px", borderRadius: "5px",
                            border: draftEdits.prodLine !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                            fontSize: "12px", outline: "none",
                            background: isJobLocked ? "#f8fafc" : "#ffffff",
                            color: isJobLocked ? "#64748b" : "#0f172a",
                            cursor: isJobLocked ? "not-allowed" : "pointer",
                            boxSizing: "border-box"
                          }}
                        >
                          <option value="">Select Product Line...</option>
                          {plOptions.map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      </div>

                      {/* VAT Applicable */}
                      <div>
                        <label style={{ display: "block", fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                          VAT Applicable?
                        </label>
                        <select
                          value={vatVal}
                          onChange={(e) => handleDraftFieldChange("vat", e.target.value)}
                          disabled={isJobLocked}
                          title={lockTooltip}
                          style={{
                            width: "100%", padding: "5px 7px", borderRadius: "5px",
                            border: draftEdits.vat !== undefined ? "1px solid #f59e0b" : "1px solid #cbd5e1",
                            fontSize: "12px", outline: "none",
                            background: isJobLocked ? "#f8fafc" : "#ffffff",
                            color: isJobLocked ? "#64748b" : "#0f172a",
                            cursor: isJobLocked ? "not-allowed" : "pointer",
                            boxSizing: "border-box"
                          }}
                        >
                          <option value="Yes">Yes</option>
                          <option value="No">No</option>
                        </select>
                      </div>

                      {/* Revenue Split */}
                      <div style={{ gridColumn: "span 2", marginTop: "4px", padding: "8px 10px", background: "#f8fafc", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <div style={{ fontSize: "11px", fontWeight: "700", color: "#334155" }}>Revenue split</div>
                            <div style={{ fontSize: "11px", color: "#64748b" }}>
                              {isRetainer
                                ? "Even monthly (Retainer)"
                                : String(unevenSplitVal).toLowerCase().startsWith("[split]")
                                  ? "Custom uneven split active"
                                  : "Even monthly distribution"}
                            </div>
                          </div>
                          {!isRetainer && (
                            <button
                              type="button"
                              disabled={isJobLocked}
                              title={isJobLocked ? lockTooltip : undefined}
                              onClick={() => {
                                if (isJobLocked) return;
                                const mergedJobRow = {
                                  ...parentRow,
                                  ...draftEdits,
                                  startDate: draftEdits.startDate !== undefined ? draftEdits.startDate : parentRow.startDate,
                                  endDate: draftEdits.endDate !== undefined ? draftEdits.endDate : parentRow.endDate,
                                  revenue: draftEdits.revenue !== undefined ? draftEdits.revenue : parentRow.revenue,
                                  client: draftEdits.client !== undefined ? draftEdits.client : parentRow.client,
                                  jobName: draftEdits.jobName !== undefined ? draftEdits.jobName : parentRow.jobName,
                                };
                                setJobsEditSplit({ jobRow: mergedJobRow, tabName });
                              }}
                              style={{
                                padding: "4px 9px", borderRadius: "5px", border: "1px solid #cbd5e1",
                                background: isJobLocked ? "#f1f5f9" : (String(unevenSplitVal).toLowerCase().startsWith("[split]") ? "#0284c7" : "#ffffff"),
                                color: isJobLocked ? "#94a3b8" : (String(unevenSplitVal).toLowerCase().startsWith("[split]") ? "#ffffff" : "#0284c7"),
                                fontSize: "11px", fontWeight: "600", cursor: isJobLocked ? "not-allowed" : "pointer"
                              }}
                            >
                              Configure Split
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Card 2: Invoices */}
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: "8px",
                      border: "1px solid #e2e8f0",
                      padding: "16px",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                      display: "flex",
                      flexDirection: "column",
                      boxSizing: "border-box",
                      maxWidth: "100%",
                      minWidth: 0,
                      overflow: "hidden"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                      <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        Invoices ({invoiceItems.length})
                      </div>
                      {isConfirmed && metrics.revenue > 0 && (
                        metrics.leftToInvoice > 0 ? (
                          <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "10px", fontWeight: "600", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                            Left to inv: {formatCurrency(metrics.leftToInvoice)}
                          </span>
                        ) : (
                          <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "10px", fontWeight: "600", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
                            ✓ Invoiced
                          </span>
                        )
                      )}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "380px", overflowY: "auto", paddingRight: "4px" }}>
                      {invoiceItems.length === 0 ? (
                        <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", padding: "8px 0" }}>
                          No invoices found.
                        </div>
                      ) : (
                        invoiceItems.map((item) => {
                          if (item.isComposite) {
                            return (
                              <div
                                key={item.id}
                                onClick={() => {
                                  const targetSlotItem = item.balanceTranche || item.receivedTranches[0] || item;
                                  setInvoicesEditSlot({
                                    rowNum: targetSlotItem.rowNum,
                                    slotNum: targetSlotItem.slotNum,
                                    slot: targetSlotItem.slot,
                                    jobClient: targetSlotItem.row?.client || parentRow.client || job.client,
                                    jobName: targetSlotItem.row?.jobName || parentRow.jobName || job.jobName,
                                    slotLabel: item.label,
                                    tabName,
                                    job
                                  });
                                }}
                                style={{
                                  padding: "9px 12px",
                                  borderRadius: "7px",
                                  border: "1px solid #bfdbfe",
                                  background: "#ffffff",
                                  cursor: "pointer",
                                  transition: "all 0.15s ease",
                                  boxSizing: "border-box",
                                  maxWidth: "100%",
                                  overflow: "hidden",
                                  flexShrink: 0,
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: "5px"
                                }}
                                title="Part-paid invoice. Click to view or edit balance payment terms."
                                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#60a5fa"; e.currentTarget.style.background = "#eff6ff"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#bfdbfe"; e.currentTarget.style.background = "#ffffff"; }}
                              >
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                      #{item.slot.ref}
                                    </span>
                                    <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", background: item.isFullyPaid ? "#dcfce7" : "#eff6ff", color: item.isFullyPaid ? "#166534" : "#1d4ed8", border: item.isFullyPaid ? "1px solid #bbf7d0" : "1px solid #bfdbfe" }}>
                                      {item.isFullyPaid ? `Paid in full (${item.receivedTranches.length} payments)` : `Part-paid (${item.percentPaid.toFixed(1)}%)`}
                                    </span>
                                    {hasAccountingIntegration && item.slot.ref && (
                                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                      </svg>
                                    )}
                                    {isRetainer && item.row && (
                                      <span style={{ fontSize: "10px", color: "#64748b" }}>
                                        ({getRetainerRowMonthLabel(item.row, 0, job)})
                                      </span>
                                    )}
                                  </div>
                                  <div style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                                    Total: {formatCurrency(item.totalAmount)}
                                  </div>
                                </div>

                                <div style={{ width: "100%", height: "4px", background: "#f1f5f9", borderRadius: "2px", overflow: "hidden" }}>
                                  <div
                                    style={{
                                      width: `${Math.min(100, Math.max(0, item.percentPaid))}%`,
                                      height: "100%",
                                      background: "#10b981",
                                      borderRadius: "2px",
                                    }}
                                  />
                                </div>

                                {item.isFullyPaid ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "1px", fontSize: "10px", color: "#475569" }}>
                                    {item.receivedTranches.map((t, tIdx) => (
                                      <div key={tIdx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                        <span style={{ color: "#166534", fontWeight: "600" }}>
                                          ✓ Payment {tIdx + 1}: {formatCurrency(parseFloat(stripCurrency(t.slot?.amount)) || 0)}
                                        </span>
                                        <span style={{ color: "#64748b" }}>
                                          {t.slot?.sentDate ? `Sent: ${t.slot.sentDate}` : ""}
                                          {t.slot?.daysToPay ? ` · Paid: ${t.slot.daysToPay}d` : ""}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "1px", fontSize: "10px", color: "#475569" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                      <span style={{ color: "#166534", fontWeight: "600" }}>
                                        ✓ {formatCurrency(item.receivedAmount)} received
                                      </span>
                                      <span style={{ color: "#64748b" }}>
                                        {item.receivedTranches[0]?.slot?.sentDate ? `Sent: ${toSheetDateFormat(item.receivedTranches[0].slot.sentDate)}` : ""}
                                        {item.receivedTranches[0]?.slot?.daysToPay ? ` · Paid: ${item.receivedTranches[0].slot.daysToPay}d` : ""}
                                      </span>
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                      <span style={{ color: "#b45309", fontWeight: "600" }}>
                                        ⏳ {formatCurrency(item.balanceAmount)} balance
                                      </span>
                                      <span style={{ color: "#64748b" }}>
                                        {item.balanceTranche?.slot?.sentDate && calculatePaymentDate(item.balanceTranche.slot.sentDate, item.balanceTranche.slot.daysToPay || 30) ? (
                                          `Due: ${calculatePaymentDate(item.balanceTranche.slot.sentDate, item.balanceTranche.slot.daysToPay || 30)} (${item.balanceTranche.slot.daysToPay || 30}d)`
                                        ) : (
                                          item.balanceTranche ? `${item.balanceTranche.slot?.daysToPay || 30} days` : "Fully paid"
                                        )}
                                      </span>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          }

                          const slot = item.slot;
                          const hasData = Boolean((slot.ref && String(slot.ref).trim() !== "") || (slot.amount && String(slot.amount).trim() !== ""));
                          const isPlaceholder = isPlaceholderInvoice(slot.ref, slot.status);
                          const pillStyle = getStatusPill(slot.status);
                          const isPaid = String(slot.status || "").trim().toLowerCase() === "paid";

                          return (
                            <div
                              key={item.id}
                              onClick={() => {
                                setInvoicesEditSlot({
                                  rowNum: item.rowNum,
                                  slotNum: item.slotNum,
                                  slot,
                                  jobClient: item.row.client || parentRow.client || job.client,
                                  jobName: item.row.jobName || parentRow.jobName || job.jobName,
                                  slotLabel: slot.ref ? `#${slot.ref}` : (isPlaceholder ? "Placeholder" : `Slot ${item.slotNum}`),
                                  tabName,
                                  job
                                });
                              }}
                              style={{
                                padding: "9px 12px",
                                borderRadius: "7px",
                                border: "1px solid #e2e8f0",
                                background: "#ffffff",
                                cursor: "pointer",
                                transition: "all 0.15s ease",
                                boxSizing: "border-box",
                                maxWidth: "100%",
                                overflow: "hidden",
                                display: "flex",
                                flexDirection: "column",
                                gap: "5px",
                                boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                              }}
                              title={
                                hasAccountingIntegration && !isPlaceholder && slot.ref && String(slot.ref).trim() !== ""
                                  ? "Synced from accounting software. Click to view or edit days to pay."
                                  : "Click to edit invoice slot"
                              }
                              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#60a5fa"; e.currentTarget.style.background = "#eff6ff"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.background = "#ffffff"; }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                  {isPlaceholder ? (
                                      <PlaceholderPill isAuto={isAutoPlaceholder(slot.ref)} size="sm" />
                                    ) : slot.ref ? (
                                      <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                        #{slot.ref}
                                      </span>
                                    ) : (
                                      <span style={{ fontSize: "12px", fontWeight: "600", color: "#475569" }}>
                                        Invoice
                                      </span>
                                    )}

                                  {hasData && slot.status && (
                                    <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", ...pillStyle }}>
                                      {slot.status}
                                    </span>
                                  )}

                                  {hasAccountingIntegration && !isPlaceholder && slot.ref && String(slot.ref).trim() !== "" && (
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                    </svg>
                                  )}

                                  <NoteIndicatorButton
                                    size="sm"
                                    note={slot.note || ""}
                                    onClick={() => openSlotNoteModal({ item, type: "invoice" })}
                                    title={slot.note ? `Invoice note: ${slot.note}` : "Add note to invoice slot"}
                                  />

                                  {isRetainer && item.row && (
                                    <span style={{ fontSize: "10px", color: "#64748b" }}>
                                      ({getRetainerRowMonthLabel(item.row, 0, job)})
                                    </span>
                                  )}
                                </div>

                                {hasData ? (
                                  <span style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                                    {formatCurrency(slot.amount)}
                                  </span>
                                ) : (
                                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                                    Click to add
                                  </span>
                                )}
                              </div>

                              {/* Progress bar (100% green if Paid) */}
                              {isPaid && (
                                <div style={{ width: "100%", height: "4px", background: "#f1f5f9", borderRadius: "2px", overflow: "hidden" }}>
                                  <div style={{ width: "100%", height: "100%", background: "#10b981", borderRadius: "2px" }} />
                                </div>
                              )}

                              {hasData && (
                                isPaid ? (
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "10px", color: "#475569" }}>
                                    <span style={{ color: "#166534", fontWeight: 600 }}>
                                      ✓ {formatCurrency(slot.amount)} paid
                                    </span>
                                    <span style={{ color: "#64748b" }}>
                                      {slot.sentDate ? `Sent: ${toSheetDateFormat(slot.sentDate)}` : ""}
                                      {slot.daysToPay ? ` · Paid: ${slot.daysToPay}d` : ""}
                                    </span>
                                  </div>
                                ) : (
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "10px", color: "#475569" }}>
                                    <span style={{ color: "#b45309", fontWeight: 600 }}>
                                      {calculatePaymentDate(slot.sentDate, slot.daysToPay || 30) ? (
                                        `Due: ${calculatePaymentDate(slot.sentDate, slot.daysToPay || 30)}`
                                      ) : (
                                        `Expected in ${slot.daysToPay || 30}d`
                                      )}
                                    </span>
                                    <span style={{ color: "#64748b" }}>
                                      {slot.sentDate ? `Sent: ${toSheetDateFormat(slot.sentDate)} (${slot.daysToPay || 30}d)` : `Terms: ${slot.daysToPay || 30}d`}
                                    </span>
                                  </div>
                                )
                              )}
                            </div>
                          );
                        })
                      )}
                      <button
                        type="button"
                        onClick={handleAddNewInvoicePlaceholder}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "6px",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          border: "1px dashed #cbd5e1",
                          background: "#f8fafc",
                          color: "#475569",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: "pointer",
                          transition: "all 0.15s ease",
                          marginTop: "2px"
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#94a3b8"; e.currentTarget.style.background = "#f1f5f9"; e.currentTarget.style.color = "#0f172a"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#cbd5e1"; e.currentTarget.style.background = "#f8fafc"; e.currentTarget.style.color = "#475569"; }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Add new
                      </button>
                    </div>
                  </div>

                  {/* Card 3: Direct Costs */}
                  <div
                    style={{
                      background: "#ffffff",
                      borderRadius: "8px",
                      border: "1px solid #e2e8f0",
                      padding: "16px",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
                      display: "flex",
                      flexDirection: "column",
                      boxSizing: "border-box",
                      maxWidth: "100%",
                      minWidth: 0,
                      overflow: "hidden"
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                      <div style={{ fontSize: "12px", fontWeight: "700", color: "#0f172a", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                        Direct Costs ({expenseItems.length})
                      </div>
                      {isConfirmed && metrics.directCosts > 0 && (
                        metrics.costsLeftToReceive > 0 ? (
                          <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "10px", fontWeight: "600", background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" }}>
                            Left to rec: {formatCurrency(metrics.costsLeftToReceive)}
                          </span>
                        ) : (
                          <span style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "10px", fontWeight: "600", background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" }}>
                            ✓ Received
                          </span>
                        )
                      )}
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "380px", overflowY: "auto", paddingRight: "4px" }}>
                      {expenseItems.length === 0 ? (
                        <div style={{ fontSize: "12px", color: "#94a3b8", fontStyle: "italic", padding: "8px 0" }}>
                          No direct costs found.
                        </div>
                      ) : (
                        expenseItems.map((item) => {
                          if (item.isComposite) {
                            return (
                              <div
                                key={item.id}
                                onClick={() => {
                                  const targetSlotItem = item.balanceTranche || item.receivedTranches[0] || item;
                                  setDirectCostsEditSlot({
                                    rowNum: targetSlotItem.rowNum,
                                    slotNum: targetSlotItem.slotNum,
                                    slot: targetSlotItem.slot,
                                    jobName: targetSlotItem.row?.jobName || parentRow.jobName || job.jobName,
                                    jobClient: targetSlotItem.row?.client || parentRow.client || job.client,
                                    slotLabel: item.label,
                                    tabName
                                  });
                                }}
                                style={{
                                  padding: "9px 12px",
                                  borderRadius: "7px",
                                  border: "1px solid #bfdbfe",
                                  background: "#ffffff",
                                  cursor: "pointer",
                                  transition: "all 0.15s ease",
                                  boxSizing: "border-box",
                                  maxWidth: "100%",
                                  overflow: "hidden",
                                  flexShrink: 0,
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: "5px"
                                }}
                                title="Part-paid expense. Click to view or edit balance payment terms."
                                onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#60a5fa"; e.currentTarget.style.background = "#eff6ff"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#bfdbfe"; e.currentTarget.style.background = "#ffffff"; }}
                              >
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                    <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                      {item.slot.description || item.slot.transactionId || "Expense"}
                                    </span>
                                    <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", background: item.isFullyPaid ? "#dcfce7" : "#eff6ff", color: item.isFullyPaid ? "#166534" : "#1d4ed8", border: item.isFullyPaid ? "1px solid #bbf7d0" : "1px solid #bfdbfe" }}>
                                      {item.isFullyPaid ? `Paid in full (${item.receivedTranches.length} payments)` : `Part-paid (${item.percentPaid.toFixed(1)}%)`}
                                    </span>
                                  </div>
                                  <div style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                                    {formatCurrency(item.totalAmount)}
                                  </div>
                                </div>

                                <div style={{ width: "100%", height: "4px", background: "#f1f5f9", borderRadius: "2px", overflow: "hidden" }}>
                                  <div
                                    style={{
                                      width: `${Math.min(100, Math.max(0, item.percentPaid))}%`,
                                      height: "100%",
                                      background: "#10b981",
                                      borderRadius: "2px",
                                    }}
                                  />
                                </div>

                                {item.isFullyPaid ? (
                                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "1px", fontSize: "10px", color: "#475569" }}>
                                    {item.receivedTranches.map((t, tIdx) => (
                                      <div key={tIdx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                        <span style={{ color: "#166534", fontWeight: "600" }}>
                                          ✓ Payment {tIdx + 1}: {formatCurrency(parseFloat(stripCurrency(t.slot?.amount)) || 0)}
                                        </span>
                                        <span style={{ color: "#64748b" }}>
                                          {t.slot?.date ? `Date: ${toSheetDateFormat(t.slot.date)}` : ""}
                                          {t.slot?.daysToPay ? ` · Paid: ${t.slot.daysToPay}d` : ""}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div style={{ display: "flex", flexDirection: "column", gap: "2px", marginTop: "1px", fontSize: "10px", color: "#475569" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                      <span style={{ color: "#166534", fontWeight: "600" }}>
                                        ✓ {formatCurrency(item.receivedAmount)} paid
                                      </span>
                                      <span style={{ color: "#64748b" }}>
                                        {item.receivedTranches[0]?.slot?.date ? `Date: ${toSheetDateFormat(item.receivedTranches[0].slot.date)}` : ""}
                                        {item.receivedTranches[0]?.slot?.daysToPay ? ` · Paid: ${item.receivedTranches[0].slot.daysToPay}d` : ""}
                                      </span>
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                      <span style={{ color: "#b45309", fontWeight: "600" }}>
                                        ⏳ {formatCurrency(item.balanceAmount)} balance
                                      </span>
                                      <span style={{ color: "#64748b" }}>
                                        {item.balanceTranche?.slot?.date && calculatePaymentDate(item.balanceTranche.slot.date, item.balanceTranche.slot.daysToPay || 30) ? (
                                          `Due: ${calculatePaymentDate(item.balanceTranche.slot.date, item.balanceTranche.slot.daysToPay || 30)} (${item.balanceTranche.slot.daysToPay || 30}d)`
                                        ) : (
                                          item.balanceTranche ? `${item.balanceTranche.slot?.daysToPay || 30} days` : "Fully paid"
                                        )}
                                      </span>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          }

                          const slot = item.slot;
                          const hasData = Boolean((slot.description && String(slot.description).trim() !== "") || (slot.amount && String(slot.amount).trim() !== "") || (slot.transactionId && String(slot.transactionId).trim() !== ""));
                          const isPlaceholder = isPlaceholderExpense(slot);
                          const pillStyle = getStatusPill(slot.status);
                          const isPaid = String(slot.status || "").trim().toLowerCase() === "paid";

                          return (
                            <div
                              key={item.id}
                              onClick={() => {
                                setDirectCostsEditSlot({
                                  rowNum: item.rowNum,
                                  slotNum: item.slotNum,
                                  slot,
                                  jobName: item.row.jobName || parentRow.jobName || job.jobName,
                                  jobClient: item.row.client || parentRow.client || job.client,
                                  slotLabel: item.label,
                                  tabName
                                });
                              }}
                              style={{
                                padding: "9px 12px",
                                borderRadius: "7px",
                                border: "1px solid #e2e8f0",
                                background: "#ffffff",
                                cursor: "pointer",
                                transition: "all 0.15s ease",
                                boxSizing: "border-box",
                                maxWidth: "100%",
                                overflow: "hidden",
                                display: "flex",
                                flexDirection: "column",
                                gap: "5px",
                                boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                              }}
                              title={
                                hasAccountingIntegration && !isPlaceholder && slot.transactionId && String(slot.transactionId).trim() !== ""
                                  ? "Synced from accounting software. Click to view or edit days to pay."
                                  : "Click to edit direct cost slot"
                              }
                              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#60a5fa"; e.currentTarget.style.background = "#eff6ff"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.background = "#ffffff"; }}
                            >
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                  {isPlaceholder ? (
                                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                                        {slot.description && !String(slot.description).trim().toUpperCase().startsWith("PLACE") && (
                                          <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                            {slot.description}
                                          </span>
                                        )}
                                        <PlaceholderPill isAuto={isAutoPlaceholder(slot.transactionId || slot.description)} size="sm" />
                                      </div>
                                    ) : (
                                      <span style={{ fontSize: "13px", fontWeight: "700", color: "#0047AB" }}>
                                        {slot.description || (slot.transactionId ? `#${slot.transactionId}` : "Expense")}
                                      </span>
                                    )}

                                  {hasData && slot.status && (
                                    <span style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "8px", fontWeight: "600", ...pillStyle }}>
                                      {slot.status}
                                    </span>
                                  )}

                                  {hasAccountingIntegration && !isPlaceholder && slot.transactionId && String(slot.transactionId).trim() !== "" && (
                                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                    </svg>
                                  )}

                                  <NoteIndicatorButton
                                    size="sm"
                                    note={slot.note || ""}
                                    onClick={() => openSlotNoteModal({ item, type: "expense" })}
                                    title={slot.note ? `Cost note: ${slot.note}` : "Add note to direct cost slot"}
                                  />

                                  {isRetainer && item.row && (
                                    <span style={{ fontSize: "10px", color: "#64748b" }}>
                                      ({getRetainerRowMonthLabel(item.row, 0, job)})
                                    </span>
                                  )}
                                </div>

                                {hasData ? (
                                  <span style={{ fontSize: "13px", fontWeight: "700", color: "#0f172a" }}>
                                    {formatCurrency(slot.amount)}
                                  </span>
                                ) : (
                                  <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                                    Click to add
                                  </span>
                                )}
                              </div>

                              {/* Progress bar (100% green if Paid) */}
                              {isPaid && (
                                <div style={{ width: "100%", height: "4px", background: "#f1f5f9", borderRadius: "2px", overflow: "hidden" }}>
                                  <div style={{ width: "100%", height: "100%", background: "#10b981", borderRadius: "2px" }} />
                                </div>
                              )}

                              {hasData && (
                                isPaid ? (
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "10px", color: "#475569" }}>
                                    <span style={{ color: "#166534", fontWeight: 600 }}>
                                      ✓ {formatCurrency(slot.amount)} paid
                                    </span>
                                    <span style={{ color: "#64748b" }}>
                                      {slot.date ? `Date: ${toSheetDateFormat(slot.date)}` : ""}
                                      {slot.daysToPay ? ` · Paid: ${slot.daysToPay}d` : ""}
                                      {slot.vat ? ` · VAT: ${slot.vat}` : ""}
                                    </span>
                                  </div>
                                ) : (
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "10px", color: "#475569" }}>
                                    <span style={{ color: "#b45309", fontWeight: 600 }}>
                                      {calculatePaymentDate(slot.date, slot.daysToPay || 30) ? (
                                        `Due: ${calculatePaymentDate(slot.date, slot.daysToPay || 30)}`
                                      ) : (
                                        `Expected in ${slot.daysToPay || 30}d`
                                      )}
                                    </span>
                                    <span style={{ color: "#64748b" }}>
                                      {slot.date ? `Date: ${toSheetDateFormat(slot.date)} (${slot.daysToPay || 30}d)` : `Terms: ${slot.daysToPay || 30}d`}
                                      {slot.vat ? ` · VAT: ${slot.vat}` : ""}
                                    </span>
                                  </div>
                                )
                              )}
                            </div>
                          );
                        })
                      )}
                      <button
                        type="button"
                        onClick={handleAddNewExpensePlaceholder}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "6px",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          border: "1px dashed #cbd5e1",
                          background: "#f8fafc",
                          color: "#475569",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: "pointer",
                          transition: "all 0.15s ease",
                          marginTop: "2px"
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = "#94a3b8"; e.currentTarget.style.background = "#f1f5f9"; e.currentTarget.style.color = "#0f172a"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#cbd5e1"; e.currentTarget.style.background = "#f8fafc"; e.currentTarget.style.color = "#475569"; }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                        Add new
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer Bar */}
          <div
            className="job-detail-modal-footer"
            style={{
              padding: "14px 24px",
              borderTop: "1px solid #e2e8f0",
              background: "#f8fafc",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "10px"
            }}
          >
            <div>
              {recentlySaved ? (
                <span style={{ fontSize: "12px", color: "#16a34a", fontWeight: "700" }}>
                  ✓ Job details saved
                </span>
              ) : isDirty ? (
                <span style={{ fontSize: "12px", color: "#b45309", fontWeight: "600" }}>
                  ⚠ Unsaved changes to this job
                </span>
              ) : null}
            </div>

            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              {!isJobLocked && isDirty && (
                <button
                  type="button"
                  onClick={handleDiscardChanges}
                  disabled={saving}
                  style={{
                    padding: "6px 14px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    color: "#475569",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: saving ? "not-allowed" : "pointer"
                  }}
                >
                  Discard changes
                </button>
              )}

              {!isJobLocked && isDirty && (
                <button
                  type="button"
                  onClick={handleSaveJob}
                  disabled={saving}
                  style={{
                    padding: "6px 16px",
                    borderRadius: "6px",
                    border: "none",
                    background: "#16a34a",
                    color: "#ffffff",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: saving ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    boxShadow: "0 1px 2px rgba(22, 163, 74, 0.2)"
                  }}
                >
                  {saving ? <><Spinner size={12} color="#ffffff" /> Saving…</> : "Save job"}
                </button>
              )}

              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#334155",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer"
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        .job-detail-cards-grid {
          display: grid;
          grid-template-columns: 1.2fr 1.4fr 1.4fr;
        }
        .job-detail-addl-info-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
        }
        @media (max-width: 900px) {
          .job-detail-cards-grid {
            grid-template-columns: 1fr !important;
            gap: 14px !important;
          }
        }
        @media (max-width: 640px) {
          .job-detail-modal-overlay {
            padding: 8px 6px !important;
          }
          .job-detail-modal-card {
            width: 100% !important;
            max-width: 100% !important;
            max-height: 96vh !important;
            border-radius: 10px !important;
          }
          .job-detail-modal-header {
            padding: 12px 14px !important;
          }
          .job-detail-modal-body {
            padding: 12px 14px !important;
          }
          .job-detail-modal-footer {
            padding: 12px 14px !important;
          }
          .job-detail-addl-info-grid {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </>
  );
}
