import React, { useState, useEffect } from "react";
import Spinner from "../Spinner";

const SECTIONS = [
  { key: "cosStaffCosts", label: "CoS staff costs", max: 10, range: "BA19:BA28", badgeColor: "#DCFCE7", textColor: "#15803D", desc: "Salaries, Wages, Employers NI, Staff Pension, Freelancers" },
  { key: "revenue", label: "Revenue", max: 16, range: "BA2:BA17", badgeColor: "#E0F2FE", textColor: "#0369A1", desc: "Sales, Fee income, Turnover, Consulting income" },
  { key: "otherCostOfSale", label: "Other cost of sale", max: 20, range: "BA59:BA78", badgeColor: "#FEF3C7", textColor: "#B45309", desc: "Direct project expenses, Materials, Hosting, Disbursements" },
  { key: "corporationTax", label: "Corporation tax", max: 3, range: "BA50:BA52", badgeColor: "#F3E8FF", textColor: "#7E22CE", desc: "Corporation tax and provisions" },
  { key: "depreciation", label: "Depreciation", max: 3, range: "BA54:BA56", badgeColor: "#F1F5F9", textColor: "#475569", desc: "Depreciation and amortisation" },
  { key: "nonOperatingIncome", label: "Non-operating income", max: 13, range: "BA81:BA93", badgeColor: "#ECFDF5", textColor: "#047857", desc: "Interest received, grants, R&D credits" },
  { key: "nonOperatingExpenses", label: "Non-operating expenses", max: 10, range: "BA101:BA110", badgeColor: "#FEE2E2", textColor: "#B91C1C", desc: "Bank interest paid, loan interest, fines" },
  { key: "ignore", label: "Ignore", max: 53, range: "BA128:BA180", badgeColor: "#E2E8F0", textColor: "#334155", desc: "Category headers, blank rows, and subtotal summary rows" },
  { key: "overheads", label: "General overheads (unmapped)", max: 999, range: "Auto-included", badgeColor: "#F8FAFC", textColor: "#64748B", desc: "Standard operating expenses (Rent, Software, Travel, etc.)" }
];

export default function CategoryMappingSuggestionModal({
  clientName,
  masterSheetId,
  isOpen,
  onClose,
  onApplied,
  isAdmin = false
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [sourceOrigin, setSourceOrigin] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("cosStaffCosts");

  // State: mapped categories grouped by section key
  const [mappings, setMappings] = useState({
    cosStaffCosts: [],
    revenue: [],
    otherCostOfSale: [],
    corporationTax: [],
    depreciation: [],
    nonOperatingIncome: [],
    nonOperatingExpenses: [],
    ignore: [],
    overheads: []
  });

  useEffect(() => {
    if (!isOpen || !clientName) return;

    let isMounted = true;
    setLoading(true);
    setFeedback(null);

    fetch(`/api/setup/suggest-category-mappings?clientName=${encodeURIComponent(clientName)}&masterSheetId=${encodeURIComponent(masterSheetId || "")}`)
      .then(res => res.json())
      .then(result => {
        if (!isMounted) return;
        if (result.success) {
          setSourceOrigin(result.sourceOrigin || (isAdmin ? "Master sheet P&L" : "P&L"));
          if (result.suggested) {
            setMappings({
              cosStaffCosts: result.suggested.cosStaffCosts || [],
              revenue: result.suggested.revenue || [],
              otherCostOfSale: result.suggested.otherCostOfSale || [],
              corporationTax: result.suggested.corporationTax || [],
              depreciation: result.suggested.depreciation || [],
              nonOperatingIncome: result.suggested.nonOperatingIncome || [],
              nonOperatingExpenses: result.suggested.nonOperatingExpenses || [],
              ignore: result.suggested.ignore || [],
              overheads: result.suggested.overheads || []
            });
          }
        } else {
          setFeedback({ type: "error", message: result.error || "Failed to load category mapping suggestions." });
        }
      })
      .catch(err => {
        if (!isMounted) return;
        setFeedback({ type: "error", message: err.message });
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, clientName, masterSheetId, isAdmin]);

  if (!isOpen) return null;

  // Move a category from one section to another
  const handleMoveCategory = (category, fromSectionKey, toSectionKey) => {
    if (fromSectionKey === toSectionKey) return;

    setMappings(prev => {
      const fromList = (prev[fromSectionKey] || []).filter(item => item !== category);
      const toList = prev[toSectionKey] || [];
      if (!toList.includes(category)) {
        return {
          ...prev,
          [fromSectionKey]: fromList,
          [toSectionKey]: [...toList, category]
        };
      }
      return {
        ...prev,
        [fromSectionKey]: fromList
      };
    });
  };

  // Remove a category entirely
  const handleRemoveCategory = (category, fromSectionKey) => {
    setMappings(prev => ({
      ...prev,
      [fromSectionKey]: (prev[fromSectionKey] || []).filter(item => item !== category)
    }));
  };

  const handleApply = async () => {
    setSaving(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/suggest-category-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          mappings
        })
      });

      const resData = await res.json();
      if (resData.success) {
        if (onApplied) onApplied(mappings);
        onClose();
      } else {
        throw new Error(resData.error || "Failed to apply category mappings.");
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  const activeSection = SECTIONS.find(s => s.key === activeTab) || SECTIONS[0];
  const currentList = mappings[activeSection.key] || [];
  const filteredList = searchQuery.trim()
    ? currentList.filter(item => item.toLowerCase().includes(searchQuery.toLowerCase().trim()))
    : currentList;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "16px"
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: "#FFFFFF",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "960px",
          height: "85vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)",
          overflow: "hidden"
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid #E2E8F0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#F8FAFC"
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
              Auto-suggest category mapping rules
            </h3>
            <p style={{ margin: "3px 0 0", fontSize: "12px", color: "#64748B" }}>
              {isAdmin
                ? `Classifying P&L categories from ${sourceOrigin} into Master Sheet KeyInfo!BA2:BA180`
                : "Classifying P&L categories from connected accounting data"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              border: "none",
              background: "transparent",
              fontSize: "20px",
              cursor: saving ? "not-allowed" : "pointer",
              color: "#94A3B8",
              padding: "4px"
            }}
          >
            ✕
          </button>
        </div>

        {/* Modal Body */}
        {loading ? (
          <div style={{ padding: "60px 0", textAlign: "center", flex: 1 }}>
            <Spinner size={32} color="#023f98" />
            <p style={{ marginTop: "12px", fontSize: "13px", color: "#64748B" }}>
              Analysing chart of accounts and classifying categories...
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
            {/* Sidebar Navigation for Sections */}
            <div
              style={{
                width: "280px",
                borderRight: "1px solid #E2E8F0",
                background: "#F8FAFC",
                overflowY: "auto",
                padding: "12px 8px"
              }}
            >
              {SECTIONS.map((sec) => {
                const count = (mappings[sec.key] || []).length;
                const isSelected = activeTab === sec.key;
                const isOverCapacity = sec.max < 999 && count > sec.max;

                return (
                  <button
                    key={sec.key}
                    type="button"
                    onClick={() => {
                      setActiveTab(sec.key);
                      setSearchQuery("");
                    }}
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      borderRadius: "8px",
                      border: "none",
                      background: isSelected ? "#FFFFFF" : "transparent",
                      boxShadow: isSelected ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
                      marginBottom: "4px",
                      cursor: "pointer",
                      textAlign: "left",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between"
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "13px", fontWeight: isSelected ? "700" : "500", color: isSelected ? "#0F172A" : "#475569" }}>
                        {sec.label}
                      </div>
                      {isAdmin && (
                        <div style={{ fontSize: "10px", color: "#94A3B8" }}>
                          {sec.range}
                        </div>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: "700",
                        padding: "2px 8px",
                        borderRadius: "10px",
                        background: isOverCapacity ? "#FEE2E2" : sec.badgeColor,
                        color: isOverCapacity ? "#B91C1C" : sec.textColor
                      }}
                    >
                      {sec.max < 999 ? `${count}/${sec.max}` : count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Section Main View */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "16px 20px" }}>
              {/* Feedback Alert */}
              {feedback && (
                <div
                  style={{
                    padding: "8px 12px",
                    borderRadius: "6px",
                    marginBottom: "12px",
                    fontSize: "12px",
                    background: feedback.type === "error" ? "#FEF2F2" : "#ECFDF5",
                    border: `1px solid ${feedback.type === "error" ? "#FECACA" : "#A7F3D0"}`,
                    color: feedback.type === "error" ? "#991B1B" : "#065F46"
                  }}
                >
                  {feedback.message}
                </div>
              )}

              {/* Section Header & Search */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px", flexWrap: "wrap", gap: "10px" }}>
                <div>
                  <h4 style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: "700", color: "#0F172A" }}>
                    {activeSection.label} ({currentList.length} categories)
                  </h4>
                  <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                    {activeSection.desc}
                  </p>
                </div>
                <input
                  type="text"
                  placeholder="Filter categories..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "1px solid #CBD5E1",
                    fontSize: "12px",
                    width: "200px"
                  }}
                />
              </div>

              {/* Over capacity warning */}
              {activeSection.max < 999 && currentList.length > activeSection.max && (
                <div style={{ padding: "8px 12px", borderRadius: "6px", background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", fontSize: "11px", marginBottom: "10px" }}>
                  ⚠️ Section holds {currentList.length} items, but {isAdmin ? `Master Sheet range ${activeSection.range}` : "this section"} allows a maximum of {activeSection.max}. Please move excess categories to General Overheads or Ignore.
                </div>
              )}

              {/* Category List */}
              <div style={{ flex: 1, overflowY: "auto", border: "1px solid #E2E8F0", borderRadius: "8px", background: "#FFFFFF" }}>
                {filteredList.length === 0 ? (
                  <div style={{ padding: "30px", textAlign: "center", color: "#94A3B8", fontSize: "13px" }}>
                    {searchQuery ? "No categories match your search." : "No categories mapped to this section."}
                  </div>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC", borderBottom: "1px solid #E2E8F0" }}>
                        <th style={{ padding: "8px 12px", textAlign: "left", fontWeight: "600", color: "#475569", fontSize: "11px" }}>Category name</th>
                        <th style={{ padding: "8px 12px", textAlign: "right", fontWeight: "600", color: "#475569", fontSize: "11px", width: "220px" }}>Move to section</th>
                        <th style={{ padding: "8px 12px", textAlign: "center", width: "50px" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredList.map((category) => (
                        <tr key={category} style={{ borderBottom: "1px solid #F1F5F9" }}>
                          <td style={{ padding: "8px 12px", color: "#1E293B", fontWeight: "500" }}>
                            {category}
                          </td>
                          <td style={{ padding: "8px 12px", textAlign: "right" }}>
                            <select
                              value={activeSection.key}
                              onChange={(e) => handleMoveCategory(category, activeSection.key, e.target.value)}
                              style={{
                                padding: "4px 8px",
                                borderRadius: "4px",
                                border: "1px solid #CBD5E1",
                                fontSize: "11px",
                                maxWidth: "200px"
                              }}
                            >
                              {SECTIONS.map((sec) => (
                                <option key={sec.key} value={sec.key}>
                                  {sec.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={{ padding: "8px 12px", textAlign: "center" }}>
                            <button
                              type="button"
                              onClick={() => handleRemoveCategory(category, activeSection.key)}
                              title="Remove category"
                              style={{
                                border: "none",
                                background: "transparent",
                                color: "#94A3B8",
                                cursor: "pointer",
                                fontSize: "14px"
                              }}
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Modal Footer */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid #E2E8F0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "#F8FAFC"
          }}
        >
          <div style={{ fontSize: "12px", color: "#64748B" }}>
            Total categories analysed: {Object.values(mappings).reduce((acc, list) => acc + (list?.length || 0), 0)}
          </div>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "1px solid #CBD5E1",
                background: "#FFFFFF",
                color: "#475569",
                fontSize: "13px",
                fontWeight: "600",
                cursor: saving ? "not-allowed" : "pointer"
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={loading || saving}
              style={{
                padding: "8px 20px",
                borderRadius: "6px",
                border: "none",
                background: "#023f98",
                color: "#FFFFFF",
                fontSize: "13px",
                fontWeight: "700",
                cursor: loading || saving ? "wait" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "8px"
              }}
            >
              {saving && <Spinner size={14} color="#FFFFFF" />}
              <span>{saving ? "Applying mappings..." : (isAdmin ? "Apply category mappings to master sheet" : "Apply category mappings")}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
