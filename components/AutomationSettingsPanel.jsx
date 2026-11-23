import React from "react";
import AdminSettingNoteTooltip from "./AdminSettingNoteTooltip";
import { MASTER_SHEET_SETTING_NOTES } from "../config/masterSheetSettingNotes";

const MONTHS_COMPARE_OPTIONS = ["1", "3", "6", "7", "12", "13"];
const INVOICE_HANDLING_METHOD_OPTIONS = ["None", "Look for slot", "Create new job", "Look then create"];
const EXPENSE_HANDLING_METHOD_OPTIONS = ["None", "Look for slot", "Look then create"];
const DEFAULT_INVOICING_DETAILS_OPTIONS = [
  "None",
  "100 at end",
  "50-50",
  "50-25-25",
  "25-25-50",
  "25-75",
  "33-33-33",
  "Even-Split",
];
const YES_NO_OPTIONS = ["Yes", "No"];
const DISCREPANCY_GAS_OPTIONS = ["Include", "Exclude", "Ignore"];
const DISCREPANCY_PMA_OPTIONS = ["Include", "Ignore"];

const INVOICE_DISCREPANCY_RULES = [
  { key: "missingInvoice", label: "Missing invoice?", cell: "DataChgAlert!B39" },
  { key: "clientMismatch", label: "Client mismatch", cell: "DataChgAlert!B40" },
  { key: "invAmtMismatch", label: "Inv amt mismatch?", cell: "DataChgAlert!B41", noteKey: "automation.inv.invAmtMismatch" },
  { key: "sentDateMismatch", label: "Sent date mismatch?", cell: "DataChgAlert!B42" },
  { key: "duplicateInvNo", label: "Duplicate inv no?", cell: "DataChgAlert!B43", noteKey: "automation.inv.duplicateInvNo" },
  { key: "fullyPaidMismatch", label: "Fully paid on mismatch?", cell: "DataChgAlert!B44" },
  { key: "statusMismatch", label: "Status mismatch?", cell: "DataChgAlert!B45" },
];

const EXPENSE_DISCREPANCY_RULES = [
  { key: "missingCost", label: "Missing cost?", cell: "DataChgAlert!B111" },
  { key: "duplicateAppId", label: "Duplicate app ID?", cell: "DataChgAlert!B112" },
  { key: "descrMismatch", label: "Descr. mismatch?", cell: "DataChgAlert!B113" },
  { key: "amountMismatch", label: "Amount mismatch?", cell: "DataChgAlert!B114", noteKey: "automation.exp.amountAndVatMismatch" },
  { key: "vatMismatch", label: "VAT mismatch?", cell: "DataChgAlert!B115", noteKey: "automation.exp.amountAndVatMismatch" },
  { key: "recDateMismatch", label: "Rec date mismatch?", cell: "DataChgAlert!B116" },
  { key: "payDateMismatch", label: "Pay date mismatch?", cell: "DataChgAlert!B117" },
  { key: "statusMismatch", label: "Status mismatch?", cell: "DataChgAlert!B118" },
];

const CRM_RULE_TABLES = [
  { key: "dashPipe", title: "Pipeline: dashboard compare", cell: "DataChgAlert!A59:C66" },
  { key: "dashConf", title: "Confirmed: dashboard compare", cell: "DataChgAlert!D59:F66" },
  { key: "crmPipe", title: "Pipeline: CRM app compare", cell: "DataChgAlert!A72:C79" },
  { key: "crmConf", title: "Confirmed: CRM app compare", cell: "DataChgAlert!D72:F79" },
];

const inputStyle = {
  width: "100%",
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid #CBD5E1",
  fontSize: "12px",
  boxSizing: "border-box",
  background: "#FFFFFF",
};

export default function AutomationSettingsPanel({
  automation = {},
  onUpdateAutomation,
  isAdmin = false,
  showCellRefs = true,
  showHeader = true,
}) {
  const renderCellRef = (cell) => {
    if (!isAdmin || !showCellRefs || !cell) return null;
    return (
      <div style={{ fontSize: "11px", color: "#94A3B8", marginTop: "3px", fontFamily: "monospace" }}>
        Cell: {cell}
      </div>
    );
  };

  const renderAdminNote = (noteKey) => {
    if (!isAdmin || !noteKey) return null;
    const notes = MASTER_SHEET_SETTING_NOTES[noteKey];
    if (!notes || notes.length === 0) return null;
    return <AdminSettingNoteTooltip isAdmin={isAdmin} notes={notes} />;
  };

  const updateSectionField = (sectionKey, fieldKey, val) => {
    onUpdateAutomation?.((prev) => ({
      ...prev,
      [sectionKey]: {
        ...(prev?.[sectionKey] || {}),
        [fieldKey]: val,
      },
    }));
  };

  const updateDiscrepancy = (sectionKey, ruleKey, val) => {
    onUpdateAutomation?.((prev) => ({
      ...prev,
      [sectionKey]: {
        ...(prev?.[sectionKey] || {}),
        discrepancies: {
          ...(prev?.[sectionKey]?.discrepancies || {}),
          [ruleKey]: val,
        },
      },
    }));
  };

  const renderSelectField = (label, value, options, onChange, { cell, noteKey, suffix = "" } = {}) => (
    <div>
      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "flex", alignItems: "center", gap: "5px", marginBottom: "3px" }}>
        <span>{label}</span>
        {noteKey && renderAdminNote(noteKey)}
      </label>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}{suffix}
          </option>
        ))}
      </select>
      {renderCellRef(cell)}
    </div>
  );

  const renderTextField = (label, value, onChange, { cell, noteKey } = {}) => (
    <div>
      <label style={{ fontSize: "12px", fontWeight: "600", color: "#334155", display: "flex", alignItems: "center", gap: "5px", marginBottom: "3px" }}>
        <span>{label}</span>
        {noteKey && renderAdminNote(noteKey)}
      </label>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle} />
      {renderCellRef(cell)}
    </div>
  );

  const renderDiscrepancyBox = (title, sectionKey, rules) => (
    <div style={{ background: "#F8FAFC", borderRadius: "8px", padding: "16px", border: "1px solid #E2E8F0" }}>
      <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", marginBottom: "12px" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: "10px" }}>
        {rules.map((r) => (
          <div key={r.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#FFFFFF", padding: "6px 10px", borderRadius: "6px", border: "1px solid #E2E8F0" }}>
            <div>
              <span style={{ fontSize: "12px", color: "#334155", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <span>{r.label}</span>
                {r.noteKey && renderAdminNote(r.noteKey)}
              </span>
              {renderCellRef(r.cell)}
            </div>
            <select
              value={automation?.[sectionKey]?.discrepancies?.[r.key] || "Include"}
              onChange={(e) => updateDiscrepancy(sectionKey, r.key, e.target.value)}
              style={{ padding: "4px 8px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
            >
              {DISCREPANCY_GAS_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div>
      {showHeader && (
        <div style={{ marginBottom: "20px", borderBottom: "1px solid #F1F5F9", paddingBottom: "12px" }}>
          <h3 style={{ margin: "0 0 4px", fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>Automations & tolerances</h3>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
            Comparison rolling windows, tolerance thresholds, and discrepancy rules.
          </p>
        </div>
      )}

      {/* Sub-section 1: Invoices */}
      <div style={{ marginBottom: "28px" }}>
        <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Invoices</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: "14px", marginBottom: "20px" }}>
          {renderSelectField("Months to compare", String(automation?.invoices?.monthsToCompare || "6"), MONTHS_COMPARE_OPTIONS, (v) => updateSectionField("invoices", "monthsToCompare", v), { cell: "DataChgAlert!B32", noteKey: "automation.inv.monthsToCompare", suffix: " months" })}
          {renderSelectField("Months for others", String(automation?.invoices?.monthsForOthers || "6"), MONTHS_COMPARE_OPTIONS, (v) => updateSectionField("invoices", "monthsForOthers", v), { cell: "DataChgAlert!B33", noteKey: "automation.inv.monthsForOthers", suffix: " months" })}
          {renderSelectField("Handling method", automation?.invoices?.handlingMethod || INVOICE_HANDLING_METHOD_OPTIONS[1], INVOICE_HANDLING_METHOD_OPTIONS, (v) => updateSectionField("invoices", "handlingMethod", v), { cell: "DataChgAlert!D39" })}
          {renderTextField("Month tolerance", automation?.invoices?.monthTolerance || "0", (v) => updateSectionField("invoices", "monthTolerance", v), { cell: "DataChgAlert!F39", noteKey: "automation.inv.monthTolerance" })}
          {renderSelectField("Include half/third amounts?", automation?.invoices?.includeHalfThird || "Yes", YES_NO_OPTIONS, (v) => updateSectionField("invoices", "includeHalfThird", v), { cell: "DataChgAlert!H39", noteKey: "automation.inv.includeHalfThird" })}
          {renderSelectField("Default project invoicing", automation?.invoices?.defaultProjectInvoiceDetails || DEFAULT_INVOICING_DETAILS_OPTIONS[2], DEFAULT_INVOICING_DETAILS_OPTIONS, (v) => updateSectionField("invoices", "defaultProjectInvoiceDetails", v), { cell: "DataChgAlert!B50", noteKey: "automation.inv.defaultProjectInvoicing" })}
          {renderTextField("Default retainer invoice date", automation?.invoices?.defaultRetainerInvoiceDate || "28", (v) => updateSectionField("invoices", "defaultRetainerInvoiceDate", v), { cell: "DataChgAlert!B51", noteKey: "automation.inv.defaultRetainerInvoiceDate" })}
          {renderTextField("Default days to pay", automation?.invoices?.defaultDaysToPay || "30", (v) => updateSectionField("invoices", "defaultDaysToPay", v), { cell: "DataChgAlert!B52", noteKey: "automation.inv.defaultDaysToPay" })}
          {renderSelectField("Update days to pay on new month", automation?.invoices?.updateDaysToPayNewMonth || "Yes", YES_NO_OPTIONS, (v) => updateSectionField("invoices", "updateDaysToPayNewMonth", v), { cell: "DataChgAlert!B47", noteKey: "automation.inv.updateDaysToPayNewMonth" })}
          {renderSelectField("Create invoices for retainers", automation?.invoices?.createInvoiceRowsRetainers || "Yes", YES_NO_OPTIONS, (v) => updateSectionField("invoices", "createInvoiceRowsRetainers", v), { cell: "DataChgAlert!B48", noteKey: "automation.inv.createInvoiceRowsRetainers" })}
        </div>

        {renderDiscrepancyBox("Invoice discrepancy rules (dashboard compare)", "invoices", INVOICE_DISCREPANCY_RULES)}
      </div>

      {/* Sub-section 2: Expenses */}
      <div style={{ marginBottom: "28px", paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
        <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>Expenses</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: "14px", marginBottom: "20px" }}>
          {renderSelectField("Months to compare", String(automation?.expenses?.monthsToCompare || "6"), MONTHS_COMPARE_OPTIONS, (v) => updateSectionField("expenses", "monthsToCompare", v), { cell: "DataChgAlert!B101", suffix: " months" })}
          {renderSelectField("Months for others", String(automation?.expenses?.monthsForOthers || "6"), MONTHS_COMPARE_OPTIONS, (v) => updateSectionField("expenses", "monthsForOthers", v), { cell: "DataChgAlert!B102", suffix: " months" })}
          {renderSelectField("Default direct cost receiving", automation?.expenses?.defaultDirectCostDetails || DEFAULT_INVOICING_DETAILS_OPTIONS[2], DEFAULT_INVOICING_DETAILS_OPTIONS, (v) => updateSectionField("expenses", "defaultDirectCostDetails", v), { cell: "DataChgAlert!B105", noteKey: "automation.exp.defaultDirectCostDetails" })}
          {renderTextField("Default retainer expense date", automation?.expenses?.defaultRetainerExpenseDate || "28", (v) => updateSectionField("expenses", "defaultRetainerExpenseDate", v), { cell: "DataChgAlert!B106", noteKey: "automation.exp.defaultRetainerExpenseDate" })}
          {renderSelectField("Handling method", automation?.expenses?.handlingMethod || EXPENSE_HANDLING_METHOD_OPTIONS[1], EXPENSE_HANDLING_METHOD_OPTIONS, (v) => updateSectionField("expenses", "handlingMethod", v), { cell: "DataChgAlert!H111" })}
          {renderTextField("Month tolerance", automation?.expenses?.monthTolerance || "0", (v) => updateSectionField("expenses", "monthTolerance", v), { cell: "DataChgAlert!J111", noteKey: "automation.exp.monthTolerance" })}
        </div>

        {renderDiscrepancyBox("Expense discrepancy rules (dashboard compare)", "expenses", EXPENSE_DISCREPANCY_RULES)}
      </div>

      {/* Sub-section 3: CRM Discrepancy Rules */}
      <div style={{ paddingTop: "20px", borderTop: "1px solid #F1F5F9" }}>
        <h4 style={{ margin: "0 0 12px", fontSize: "14px", fontWeight: "700", color: "#0F172A" }}>CRM discrepancy rules</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: "14px", marginBottom: "18px" }}>
          {renderSelectField("CRM months to compare", String(automation?.crm?.monthsToCompare || "6"), MONTHS_COMPARE_OPTIONS, (v) => updateSectionField("crm", "monthsToCompare", v), { cell: "DataChgAlert!B55", noteKey: "automation.crm.monthsToCompare", suffix: " months" })}
          {renderSelectField("Pipeline mode - add jobs to confirmed?", automation?.crm?.pipelineAddJobsToConf || "Yes", YES_NO_OPTIONS, (v) => updateSectionField("crm", "pipelineAddJobsToConf", v), { cell: "DataChgAlert!B82", noteKey: "automation.crm.pipelineAddJobsToConf" })}
        </div>

        {CRM_RULE_TABLES.map((table) => {
          const rules = automation?.crm?.rules?.[table.key] || [];
          return (
            <div key={table.key} style={{ background: "#F8FAFC", borderRadius: "8px", padding: "14px", border: "1px solid #E2E8F0", marginBottom: "14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                <div style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span>{table.title}</span>
                  {table.key === "crmConf" && renderAdminNote("automation.crm.table.crmConf")}
                </div>
                {renderCellRef(table.cell)}
              </div>
              <div style={{ border: "1px solid #E2E8F0", borderRadius: "6px", overflowX: "auto", WebkitOverflowScrolling: "touch", background: "#FFFFFF" }}>
                <table style={{ width: "100%", minWidth: "420px", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ background: "#F1F5F9", borderBottom: "1px solid #E2E8F0", textAlign: "left" }}>
                      <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569" }}>Discrepancy rule</th>
                      <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "140px" }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                          <span>{isAdmin ? "GAS automation" : "Scheduled automation"}</span>
                          {renderAdminNote("automation.crm.col.gasAutomation")}
                        </div>
                      </th>
                      <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "140px" }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                          <span>PMA alerts</span>
                          {renderAdminNote("automation.crm.col.pmaAlerts")}
                        </div>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((r, rIdx) => {
                      const lowerLabel = String(r.label || "").toLowerCase();
                      const isMissingJobRule =
                        (table.key === "crmPipe" || table.key === "crmConf") &&
                        lowerLabel.includes("missing job");
                      const isLikelihoodRule = lowerLabel.includes("likel");
                      const updateRuleCol = (colField, nextVal) => {
                        onUpdateAutomation?.((prev) => {
                          const nextRules = [...(prev?.crm?.rules?.[table.key] || [])];
                          nextRules[rIdx] = { ...nextRules[rIdx], [colField]: nextVal };
                          return {
                            ...prev,
                            crm: {
                              ...(prev?.crm || {}),
                              rules: {
                                ...(prev?.crm?.rules || {}),
                                [table.key]: nextRules,
                              },
                            },
                          };
                        });
                      };
                      return (
                        <tr key={rIdx} style={{ borderBottom: "1px solid #F1F5F9" }}>
                          <td style={{ padding: "6px 10px", color: "#334155", fontWeight: "500" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                              <span>{r.label}</span>
                              {isMissingJobRule && renderAdminNote("automation.crm.row.crmMissingJob")}
                              {isLikelihoodRule && renderAdminNote("automation.crm.row.likelihoodMismatch")}
                            </span>
                          </td>
                          <td style={{ padding: "6px 10px" }}>
                            <select
                              value={r.gasAction || "Include"}
                              onChange={(e) => updateRuleCol("gasAction", e.target.value)}
                              style={{ padding: "3px 6px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                            >
                              {DISCREPANCY_GAS_OPTIONS.map((opt) => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: "6px 10px" }}>
                            <select
                              value={r.pmaAction || "Include"}
                              onChange={(e) => updateRuleCol("pmaAction", e.target.value)}
                              style={{ padding: "3px 6px", borderRadius: "4px", border: "1px solid #CBD5E1", fontSize: "11px", fontWeight: "600" }}
                            >
                              {DISCREPANCY_PMA_OPTIONS.map((opt) => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
