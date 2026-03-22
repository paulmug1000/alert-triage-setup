import React, { useState } from "react";
import TriageSystem from "./triage";

export default function MainMenu() {
  const [mode, setMode] = useState("menu"); // menu or triage

  if (mode === "triage") {
    return <TriageSystem onBack={() => setMode("menu")} />;
  }

  return (
    <div style={styles.container}>
      <div style={styles.wrapper}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage System</h1>
          <p style={styles.subtitle}>
            AI-powered financial automation alert analysis
          </p>
        </div>

        <div style={styles.grid}>
          {/* Triage Mode */}
          <div style={styles.card} onClick={() => setMode("triage")}>
            <div style={styles.cardIcon}>🔍</div>
            <h2 style={styles.cardTitle}>Alert Triage</h2>
            <p style={styles.cardDescription}>
              Review and resolve discrepancies flagged by your automation system.
              Claude analyzes each alert and suggests the best action.
            </p>
            <div style={styles.cardMeta}>
              <span>Run weekly or as needed</span>
              <span>Learn from decisions</span>
            </div>
            <button style={styles.cardButton}>Start Triage →</button>
          </div>
        </div>

        <div style={styles.infoSection}>
          <h3>How It Works</h3>
          <ol style={styles.infoList}>
            <li>
              <strong>Knowledge Base:</strong> Populated from Phase 1 interview &
              AIKnowledgeBase sheet
            </li>
            <li>
              <strong>Weekly Triage:</strong> Review alerts flagged by your
              automation system
            </li>
            <li>
              <strong>Claude Analysis:</strong> AI analyzes each alert with your
              knowledge base
            </li>
            <li>
              <strong>Learning:</strong> Decisions logged for future improvements
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    background: "linear-gradient(to bottom right, #0f172a, #1e293b, #0f172a)",
    color: "white",
    padding: "2rem 1rem",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  wrapper: {
    maxWidth: "1200px",
    margin: "0 auto",
  },
  header: {
    textAlign: "center",
    marginBottom: "3rem",
  },
  title: {
    fontSize: "3rem",
    fontWeight: "700",
    margin: "0 0 0.5rem 0",
    letterSpacing: "-0.02em",
    background: "linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
    backgroundClip: "text",
  },
  subtitle: {
    color: "#cbd5e1",
    fontSize: "1.125rem",
    margin: "0",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: "2rem",
    marginBottom: "3rem",
  },
  card: {
    background: "rgba(30, 41, 59, 0.5)",
    border: "1px solid rgba(148, 163, 184, 0.2)",
    borderRadius: "1rem",
    padding: "2rem",
    cursor: "pointer",
    transition: "all 0.3s ease",
    display: "flex",
    flexDirection: "column",
  },
  cardHover: {
    background: "rgba(30, 41, 59, 0.8)",
    borderColor: "rgba(59, 130, 246, 0.5)",
  },
  cardIcon: {
    fontSize: "3rem",
    marginBottom: "1rem",
  },
  cardTitle: {
    fontSize: "1.5rem",
    fontWeight: "700",
    margin: "0 0 0.75rem 0",
    color: "#22d3ee",
  },
  cardDescription: {
    color: "#cbd5e1",
    fontSize: "0.95rem",
    lineHeight: "1.6",
    margin: "0 0 1.5rem 0",
    flex: 1,
  },
  cardMeta: {
    display: "flex",
    gap: "1rem",
    marginBottom: "1.5rem",
    fontSize: "0.75rem",
    color: "#94a3b8",
  },
  cardButton: {
    background: "linear-gradient(90deg, #3b82f6 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "0.5rem",
    padding: "0.75rem 1.5rem",
    fontWeight: "600",
    fontSize: "0.875rem",
    cursor: "pointer",
    transition: "opacity 0.2s",
  },
  infoSection: {
    background: "rgba(30, 58, 138, 0.15)",
    border: "1px solid rgba(59, 130, 246, 0.3)",
    borderRadius: "1rem",
    padding: "2rem",
  },
  infoList: {
    margin: "1rem 0 0 0",
    paddingLeft: "1.5rem",
    color: "#cbd5e1",
    lineHeight: "2",
  },
};
