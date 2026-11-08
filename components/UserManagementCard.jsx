import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";

const ROLE_OPTIONS = [
  {
    value: "ClientUser",
    label: "Client user",
    description: "Accesses the Pulse portal for assigned clients only.",
  },
  {
    value: "ClientManager",
    label: "Client manager",
    description: "Manages assigned clients in PMA and Pulse portal.",
  },
  {
    value: "Senior (Restricted)",
    label: "Senior (restricted)",
    description: "Internal team access to assigned clients without system admin controls.",
  },
  {
    value: "Admin",
    label: "System admin",
    description: "Full access to all clients, PMA system settings, and control plane.",
  },
];

function getRoleBadgeStyle(role) {
  if (role === "Admin") {
    return { background: "#ede9fe", color: "#5b21b6", border: "1px solid #ddd6fe" };
  }
  if (role === "Senior (Restricted)") {
    return { background: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" };
  }
  if (role === "ClientManager") {
    return { background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" };
  }
  return { background: "#f1f5f9", color: "#334155", border: "1px solid #e2e8f0" };
}

function getRoleDisplayLabel(role) {
  const found = ROLE_OPTIONS.find(r => r.value === role);
  return found ? found.label : role;
}

export default function UserManagementCard({
  automationCommanderSheetId,
  currentUserEmail = "",
  defaultClientFilter = "",
  onUsersUpdated,
}) {
  const [users, setUsers] = useState([]);
  const [clientNames, setClientNames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [searchQuery, setSearchQuery] = useState(defaultClientFilter || "");
  const [roleFilter, setRoleFilter] = useState("all");

  // Add / Edit form state
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingEmail, setEditingEmail] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formName, setFormName] = useState("");
  const [formRole, setFormRole] = useState("ClientUser");
  const [formClients, setFormClients] = useState([]);
  const [formStatus, setFormStatus] = useState("Active");
  const [formDailyEmail, setFormDailyEmail] = useState("Yes");
  const [clientSearch, setClientSearch] = useState("");
  const [confirmDeleteEmail, setConfirmDeleteEmail] = useState("");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list_users",
          automationCommanderSheetId,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load users");
      }
      setUsers(data.users || []);
      if (Array.isArray(data.clientNames)) {
        setClientNames(data.clientNames);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [automationCommanderSheetId]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const openAddUser = (preselectedClient = "") => {
    setEditingEmail("");
    setFormEmail("");
    setFormName("");
    setFormRole("ClientUser");
    setFormClients(preselectedClient ? [preselectedClient] : []);
    setFormStatus("Active");
    setFormDailyEmail("Yes");
    setClientSearch("");
    setError("");
    setNotice("");
    setIsFormOpen(true);
  };

  const openEditUser = (u) => {
    setEditingEmail(u.email);
    setFormEmail(u.email);
    setFormName(u.name || "");
    setFormRole(u.role || "ClientUser");
    setFormClients(
      Array.isArray(u.assignedClients)
        ? u.assignedClients.filter(c => c && c !== "*")
        : []
    );
    setFormStatus(u.status === "Suspended" ? "Suspended" : "Active");
    setFormDailyEmail(u.dailyAlertsEmail === "No" ? "No" : "Yes");
    setClientSearch("");
    setError("");
    setNotice("");
    setIsFormOpen(true);
  };

  const handleToggleClient = (cName) => {
    setFormClients(prev =>
      prev.includes(cName) ? prev.filter(c => c !== cName) : [...prev, cName]
    );
  };

  const handleSaveUser = async (e) => {
    if (e) e.preventDefault();
    if (!formEmail.trim() || !formEmail.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (formRole !== "Admin" && formClients.length === 0) {
      setError("Please assign at least one client for non-admin users.");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_user",
          automationCommanderSheetId,
          userPayload: {
            email: formEmail.trim().toLowerCase(),
            name: formName.trim(),
            role: formRole,
            assignedClients: formRole === "Admin" ? ["*"] : formClients,
            status: formStatus,
            dailyAlertsEmail: formDailyEmail,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save user");
      }
      setUsers(data.users || []);
      setIsFormOpen(false);
      setNotice(
        data.isNew
          ? `Added user ${formEmail.trim().toLowerCase()}.`
          : `Updated user ${formEmail.trim().toLowerCase()}.`
      );
      if (typeof onUsersUpdated === "function") {
        onUsersUpdated(data.users || []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleQuickStatusToggle = async (u) => {
    const nextStatus = u.status === "Suspended" ? "Active" : "Suspended";
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_user",
          automationCommanderSheetId,
          userPayload: {
            email: u.email,
            name: u.name,
            role: u.role,
            assignedClients: u.role === "Admin" ? ["*"] : u.assignedClients,
            status: nextStatus,
            dailyAlertsEmail: u.dailyAlertsEmail,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to update user status");
      }
      setUsers(data.users || []);
      setNotice(
        `${nextStatus === "Suspended" ? "Suspended" : "Reactivated"} ${u.email}.`
      );
      if (typeof onUsersUpdated === "function") {
        onUsersUpdated(data.users || []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async (email) => {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/pma/control-plane", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_user",
          automationCommanderSheetId,
          email,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to delete user");
      }
      setUsers(data.users || []);
      setConfirmDeleteEmail("");
      setNotice(`Removed user ${email}.`);
      if (typeof onUsersUpdated === "function") {
        onUsersUpdated(data.users || []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const filteredUsers = useMemo(() => {
    return users.filter(u => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (!searchQuery.trim()) return true;
      const q = searchQuery.trim().toLowerCase();
      const emailMatch = String(u.email || "").toLowerCase().includes(q);
      const nameMatch = String(u.name || "").toLowerCase().includes(q);
      const clientMatch = Array.isArray(u.assignedClients)
        ? u.assignedClients.some(c => String(c).toLowerCase().includes(q))
        : String(u.assignedClients || "").toLowerCase().includes(q);
      return emailMatch || nameMatch || clientMatch;
    });
  }, [users, roleFilter, searchQuery]);

  const filteredClientOptions = useMemo(() => {
    if (!clientSearch.trim()) return clientNames;
    const q = clientSearch.trim().toLowerCase();
    return clientNames.filter(c => c.toLowerCase().includes(q));
  }, [clientNames, clientSearch]);

  return (
    <div
      style={{
        background: "white",
        borderRadius: 12,
        border: "1px solid #e2e8f0",
        padding: 24,
        marginBottom: 20,
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0f172a" }}>
              User management & permissions
            </h3>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "3px 10px",
                borderRadius: 999,
                background: "#f1f5f9",
                color: "#334155",
              }}
            >
              {users.length} {users.length === 1 ? "user" : "users"}
            </span>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>
            Add, edit, or suspend Pulse portal and PMA users. Changes save immediately to Supabase and mirror to the legacy control sheet in the background.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={loadUsers}
            disabled={loading || saving}
            style={{
              padding: "8px 14px",
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 8,
              border: "1px solid #cbd5e1",
              background: "white",
              color: "#334155",
              cursor: loading ? "not-allowed" : "pointer",
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => openAddUser(defaultClientFilter)}
            disabled={saving}
            style={{
              padding: "8px 16px",
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 8,
              border: "none",
              background: "#2563eb",
              color: "white",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            + Add new user
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: 12,
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: "#f0fdf4",
            border: "1px solid #bbf7d0",
            color: "#166534",
            fontSize: 12,
            marginBottom: 14,
          }}
        >
          {notice}
        </div>
      )}

      {/* Add / Edit User Form Panel */}
      {isFormOpen && (
        <form
          onSubmit={handleSaveUser}
          style={{
            background: "#f8fafc",
            border: "1px solid #cbd5e1",
            borderRadius: 10,
            padding: 18,
            marginBottom: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 14,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>
              {editingEmail ? `Edit user (${editingEmail})` : "Add new user"}
            </div>
            <button
              type="button"
              onClick={() => setIsFormOpen(false)}
              style={{
                background: "transparent",
                border: "none",
                color: "#64748b",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
              marginBottom: 14,
            }}
          >
            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 4 }}>
                Email address *
              </label>
              <input
                type="email"
                required
                disabled={Boolean(editingEmail)}
                value={formEmail}
                onChange={e => setFormEmail(e.target.value)}
                placeholder="name@company.com"
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  background: editingEmail ? "#f1f5f9" : "white",
                  color: "#0f172a",
                }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 4 }}>
                Full name
              </label>
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                placeholder="e.g. Sarah Jenkins"
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  background: "white",
                  color: "#0f172a",
                }}
              />
            </div>

            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 4 }}>
                Role *
              </label>
              <select
                value={formRole}
                onChange={e => setFormRole(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  background: "white",
                  color: "#0f172a",
                }}
              >
                {ROLE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 4 }}>
                Account status
              </label>
              <select
                value={formStatus}
                onChange={e => setFormStatus(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  background: "white",
                  color: "#0f172a",
                }}
              >
                <option value="Active">Active</option>
                <option value="Suspended">Suspended</option>
              </select>
            </div>

            <div>
              <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#334155", marginBottom: 4 }}>
                Daily alerts digest email
              </label>
              <select
                value={formDailyEmail}
                onChange={e => setFormDailyEmail(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: 13,
                  borderRadius: 6,
                  border: "1px solid #cbd5e1",
                  background: "white",
                  color: "#0f172a",
                }}
              >
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
          </div>

          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
            {ROLE_OPTIONS.find(r => r.value === formRole)?.description}
          </div>

          {/* Assigned clients selector */}
          {formRole === "Admin" ? (
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                background: "#ede9fe",
                color: "#5b21b6",
                fontSize: 12,
                fontWeight: 600,
                marginBottom: 14,
              }}
            >
              System admins automatically have access to all clients (*).
            </div>
          ) : (
            <div style={{ marginBottom: 14 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <label style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>
                  Assigned clients ({formClients.length} selected) *
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="text"
                    value={clientSearch}
                    onChange={e => setClientSearch(e.target.value)}
                    placeholder="Filter clients..."
                    style={{
                      padding: "4px 8px",
                      fontSize: 12,
                      borderRadius: 6,
                      border: "1px solid #cbd5e1",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setFormClients([...clientNames])}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: "#2563eb",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormClients([])}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: "#64748b",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div
                style={{
                  maxHeight: 165,
                  overflowY: "auto",
                  background: "white",
                  border: "1px solid #cbd5e1",
                  borderRadius: 8,
                  padding: 10,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))",
                  gap: 6,
                }}
              >
                {filteredClientOptions.map(cName => {
                  const checked = formClients.includes(cName);
                  return (
                    <label
                      key={cName}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12,
                        padding: "4px 6px",
                        borderRadius: 6,
                        cursor: "pointer",
                        background: checked ? "#eff6ff" : "transparent",
                        color: checked ? "#1d4ed8" : "#334155",
                        fontWeight: checked ? 600 : 400,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleToggleClient(cName)}
                      />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {cName}
                      </span>
                    </label>
                  );
                })}
                {filteredClientOptions.length === 0 && (
                  <div style={{ fontSize: 12, color: "#94a3b8", padding: 4 }}>
                    No matching clients found.
                  </div>
                )}
              </div>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={() => setIsFormOpen(false)}
              style={{
                padding: "8px 14px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 6,
                border: "1px solid #cbd5e1",
                background: "white",
                color: "#334155",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              style={{
                padding: "8px 16px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: 6,
                border: "none",
                background: "#2563eb",
                color: "white",
                cursor: saving ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {saving && <Spinner size={12} color="white" />}
              {editingEmail ? "Save changes" : "Add user"}
            </button>
          </div>
        </form>
      )}

      {/* Search & filter bar */}
      <div
        style={{
          display: "flex",
          gap: 10,
          marginBottom: 14,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search by name, email, or assigned client..."
          style={{
            flex: "1 1 240px",
            padding: "8px 12px",
            fontSize: 13,
            borderRadius: 8,
            border: "1px solid #cbd5e1",
          }}
        />
        <select
          value={roleFilter}
          onChange={e => setRoleFilter(e.target.value)}
          style={{
            padding: "8px 12px",
            fontSize: 13,
            borderRadius: 8,
            border: "1px solid #cbd5e1",
            background: "white",
            color: "#334155",
          }}
        >
          <option value="all">All roles ({users.length})</option>
          {ROLE_OPTIONS.map(r => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {/* Users table */}
      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 16, fontSize: 13, color: "#64748b" }}>
          <Spinner size={16} /> Loading users...
        </div>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                <th style={{ padding: "10px 12px", color: "#475569", fontWeight: 600 }}>User</th>
                <th style={{ padding: "10px 12px", color: "#475569", fontWeight: 600 }}>Role</th>
                <th style={{ padding: "10px 12px", color: "#475569", fontWeight: 600 }}>Assigned clients</th>
                <th style={{ padding: "10px 12px", color: "#475569", fontWeight: 600 }}>Status</th>
                <th style={{ padding: "10px 12px", color: "#475569", fontWeight: 600 }}>Daily email</th>
                <th style={{ padding: "10px 12px", color: "#475569", fontWeight: 600 }}>Last login</th>
                <th style={{ padding: "10px 12px", color: "#475569", fontWeight: 600, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map(u => {
                const isSelf = currentUserEmail && u.email.toLowerCase() === currentUserEmail.toLowerCase();
                const assignedList = u.assignedClients === "*"
                  ? ["*"]
                  : Array.isArray(u.assignedClients)
                  ? u.assignedClients
                  : [];

                return (
                  <tr key={u.email} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ fontWeight: 600, color: "#0f172a" }}>{u.name || u.email}</div>
                      <div style={{ color: "#64748b", fontSize: 11 }}>{u.email}</div>
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span
                        style={{
                          ...getRoleBadgeStyle(u.role),
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {getRoleDisplayLabel(u.role)}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", maxWidth: 280 }}>
                      {u.role === "Admin" || assignedList.includes("*") ? (
                        <span style={{ fontSize: 11, color: "#5b21b6", fontWeight: 600 }}>
                          All clients (*)
                        </span>
                      ) : assignedList.length === 0 ? (
                        <span style={{ fontSize: 11, color: "#94a3b8" }}>None assigned</span>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {assignedList.slice(0, 4).map(c => (
                            <span
                              key={c}
                              style={{
                                background: "#f1f5f9",
                                color: "#334155",
                                padding: "2px 6px",
                                borderRadius: 4,
                                fontSize: 11,
                              }}
                            >
                              {c}
                            </span>
                          ))}
                          {assignedList.length > 4 && (
                            <span
                              title={assignedList.slice(4).join(", ")}
                              style={{
                                background: "#e2e8f0",
                                color: "#475569",
                                padding: "2px 6px",
                                borderRadius: 4,
                                fontSize: 11,
                                fontWeight: 600,
                              }}
                            >
                              +{assignedList.length - 4} more
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 600,
                          background: u.status === "Suspended" ? "#fee2e2" : "#dcfce7",
                          color: u.status === "Suspended" ? "#991b1b" : "#166534",
                        }}
                      >
                        {u.status === "Suspended" ? "Suspended" : "Active"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", color: "#475569" }}>
                      {u.dailyAlertsEmail === "No" ? "No" : "Yes"}
                    </td>
                    <td style={{ padding: "10px 12px", color: "#64748b", fontSize: 11, whiteSpace: "nowrap" }}>
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "Never"}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        <button
                          type="button"
                          onClick={() => openEditUser(u)}
                          style={{
                            padding: "4px 8px",
                            fontSize: 11,
                            fontWeight: 600,
                            borderRadius: 6,
                            border: "1px solid #cbd5e1",
                            background: "white",
                            color: "#334155",
                            cursor: "pointer",
                          }}
                        >
                          Edit
                        </button>
                        {!isSelf && (
                          <button
                            type="button"
                            onClick={() => handleQuickStatusToggle(u)}
                            disabled={saving}
                            style={{
                              padding: "4px 8px",
                              fontSize: 11,
                              fontWeight: 600,
                              borderRadius: 6,
                              border: "1px solid #cbd5e1",
                              background: "white",
                              color: u.status === "Suspended" ? "#166534" : "#b45309",
                              cursor: saving ? "not-allowed" : "pointer",
                            }}
                          >
                            {u.status === "Suspended" ? "Activate" : "Suspend"}
                          </button>
                        )}
                        {!isSelf && (
                          confirmDeleteEmail === u.email ? (
                            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              <button
                                type="button"
                                onClick={() => handleDeleteUser(u.email)}
                                disabled={saving}
                                style={{
                                  padding: "4px 8px",
                                  fontSize: 11,
                                  fontWeight: 600,
                                  borderRadius: 6,
                                  border: "none",
                                  background: "#dc2626",
                                  color: "white",
                                  cursor: "pointer",
                                }}
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteEmail("")}
                                style={{
                                  padding: "4px 6px",
                                  fontSize: 11,
                                  borderRadius: 6,
                                  border: "1px solid #cbd5e1",
                                  background: "white",
                                  color: "#64748b",
                                  cursor: "pointer",
                                }}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteEmail(u.email)}
                              style={{
                                padding: "4px 8px",
                                fontSize: 11,
                                fontWeight: 600,
                                borderRadius: 6,
                                border: "1px solid #fecaca",
                                background: "#fef2f2",
                                color: "#dc2626",
                                cursor: "pointer",
                              }}
                            >
                              Remove
                            </button>
                          )
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filteredUsers.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 20, textAlign: "center", color: "#94a3b8" }}>
                    No users match your search filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

