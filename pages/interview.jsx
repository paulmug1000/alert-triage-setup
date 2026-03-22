import React, { useState, useEffect, useRef } from "react";

export default function SetupInterview() {
  const [sessionId, setSessionId] = useState(null);
  const [stage, setStage] = useState(0);
  const [totalStages, setTotalStages] = useState(6);
  const [stageInfo, setStageInfo] = useState(null);
  const [question, setQuestion] = useState("");
  const [userAnswer, setUserAnswer] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [knowledgeBaseUrl, setKnowledgeBaseUrl] = useState("");
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const messagesEndRef = useRef(null);

  useEffect(() => {
    startInterview();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const startInterview = async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });

      const data = await response.json();

      if (data.success) {
        setSessionId(data.sessionId);
        setStage(data.stage);
        setTotalStages(data.totalStages);
        setStageInfo(data.stageInfo);
        setQuestion(data.question);
        setMessages([
          {
            role: "assistant",
            text: data.question,
            timestamp: new Date(),
          },
        ]);
        setError("");
      } else {
        setError(data.error || "Failed to start interview");
      }
    } catch (err) {
      setError(`Error: ${err.message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const submitAnswer = async () => {
    if (!userAnswer.trim() || !sessionId) return;

    try {
      setIsLoading(true);
      const answer = userAnswer;

      setMessages((prev) => [
        ...prev,
        {
          role: "user",
          text: answer,
          timestamp: new Date(),
        },
      ]);
      setUserAnswer("");

      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "answer",
          sessionId,
          stage,
          answer,
        }),
      });

      const data = await response.json();

      if (data.success) {
        if (data.complete) {
          setIsComplete(true);
          setKnowledgeBaseUrl(data.knowledgeBaseUrl);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text: "✅ Interview complete! Your knowledge base has been created and saved to Google Docs.",
              timestamp: new Date(),
            },
          ]);
        } else {
          setStage(data.stage);
          setStageInfo(data.stageInfo);
          setQuestion(data.question);
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text: data.question,
              timestamp: new Date(),
            },
          ]);
        }
        setError("");
      } else {
        setError(data.error || "Failed to process answer");
        setMessages((prev) => prev.slice(0, -1));
      }
    } catch (err) {
      setError(`Error: ${err.message}`);
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && e.ctrlKey) {
      submitAnswer();
    }
  };

  const progressPercent = ((stage + 1) / totalStages) * 100;

  return (
    <div style={styles.container}>
      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div style={styles.wrapper}>
        <div style={styles.header}>
          <h1 style={styles.title}>Alert Triage Setup</h1>
          <p style={styles.subtitle}>Building your system knowledge base</p>
          <div style={styles.progressBar}>
            <div
              style={{
                ...styles.progressFill,
                width: `${progressPercent}%`,
              }}
            />
          </div>
        </div>

        {stageInfo && !isComplete && (
          <div style={styles.stageInfo}>
            <h2 style={styles.stageTitle}>{stageInfo.title}</h2>
            <p style={styles.stageDescription}>{stageInfo.description}</p>
            <p style={styles.stageNumber}>
              Stage {stage + 1} of {totalStages}
            </p>
          </div>
        )}

        {!isComplete && (
          <>
            <div style={styles.chatContainer}>
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  style={{
                    ...styles.message,
                    alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  <div
                    style={{
                      ...styles.messageBubble,
                      ...(msg.role === "user"
                        ? styles.messageBubbleUser
                        : styles.messageBubbleAssistant),
                    }}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
              {isLoading && (
                <div style={{ ...styles.message, alignSelf: "flex-start" }}>
                  <div style={styles.loadingIndicator}>
                    <span style={styles.spinner}></span>
                    Thinking...
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div style={styles.inputArea}>
              {error && <div style={styles.errorBanner}>{error}</div>}

              <textarea
                value={userAnswer}
                onChange={(e) => setUserAnswer(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your answer here... (Ctrl+Enter to submit)"
                rows={4}
                disabled={isLoading}
                style={styles.textarea}
              />

              <button
                onClick={submitAnswer}
                disabled={!userAnswer.trim() || isLoading}
                style={{
                  ...styles.button,
                  opacity: !userAnswer.trim() || isLoading ? 0.5 : 1,
                  cursor:
                    !userAnswer.trim() || isLoading ? "not-allowed" : "pointer",
                }}
              >
                {isLoading ? "Processing..." : "Submit Answer →"}
              </button>
            </div>
          </>
        )}

        {isComplete && (
          <div style={styles.completionCard}>
            <div style={styles.completionIcon}>✅</div>
            <h2 style={styles.completionTitle}>Interview Complete!</h2>
            <p style={styles.completionText}>
              Your knowledge base has been created and saved to Google Docs.
            </p>
            {knowledgeBaseUrl && (
              <a
                href={knowledgeBaseUrl}
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  window.open(knowledgeBaseUrl, "_blank");
                }}
                style={styles.completionButton}
              >
                View Knowledge Base
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    background: "linear-gradient(to bottom right, #0f172a, #1e293b, #0f172a)",
    color: "white",
    padding: "1rem",
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif",
  },
  wrapper: {
    maxWidth: "900px",
    margin: "0 auto",
  },
  header: {
    marginBottom: "2rem",
  },
  title: {
    fontSize: "2rem",
    fontWeight: "700",
    margin: "0 0 0.5rem 0",
    letterSpacing: "-0.02em",
  },
  subtitle: {
    color: "#cbd5e1",
    fontSize: "0.875rem",
    margin: "0",
  },
  progressBar: {
    height: "3px",
    background: "#1e293b",
    borderRadius: "9999px",
    overflow: "hidden",
    marginTop: "1rem",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg, #3b82f6 0%, #06b6d4 100%)",
    transition: "width 0.5s ease",
  },
  stageInfo: {
    marginBottom: "1.5rem",
    padding: "1rem",
    background: "rgba(30, 41, 59, 0.5)",
    border: "1px solid rgba(148, 163, 184, 0.2)",
    borderRadius: "0.5rem",
  },
  stageTitle: {
    fontSize: "1.25rem",
    fontWeight: "600",
    color: "#22d3ee",
    margin: "0 0 0.25rem 0",
  },
  stageDescription: {
    color: "#94a3b8",
    fontSize: "0.875rem",
    margin: "0",
  },
  stageNumber: {
    color: "#cbd5e1",
    fontSize: "0.75rem",
    margin: "0.5rem 0 0 0",
  },
  chatContainer: {
    background: "rgba(15, 23, 42, 0.6)",
    border: "1px solid rgba(148, 163, 184, 0.2)",
    borderRadius: "0.75rem",
    padding: "1.5rem",
    height: "400px",
    overflowY: "auto",
    marginBottom: "1.5rem",
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  message: {
    display: "flex",
    animation: "slideIn 0.3s ease",
  },
  messageBubble: {
    padding: "0.75rem 1rem",
    borderRadius: "0.5rem",
    wordWrap: "break-word",
    lineHeight: "1.5",
    fontSize: "0.875rem",
    maxWidth: "80%",
  },
  messageBubbleUser: {
    background: "#2563eb",
    borderBottomRightRadius: "0.125rem",
  },
  messageBubbleAssistant: {
    background: "rgba(71, 85, 105, 0.5)",
    borderBottomLeftRadius: "0.125rem",
    color: "#e2e8f0",
  },
  loadingIndicator: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    fontSize: "0.875rem",
    color: "#94a3b8",
  },
  spinner: {
    display: "inline-block",
    width: "12px",
    height: "12px",
    border: "2px solid #475569",
    borderTopColor: "#06b6d4",
    borderRadius: "50%",
    animation: "spin 0.6s linear infinite",
  },
  inputArea: {
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  errorBanner: {
    background: "rgba(127, 29, 29, 0.3)",
    border: "1px solid rgba(239, 68, 68, 0.5)",
    borderRadius: "0.5rem",
    padding: "1rem",
    color: "#fca5a5",
    fontSize: "0.875rem",
  },
  textarea: {
    width: "100%",
    background: "#1e293b",
    color: "white",
    border: "1px solid #475569",
    borderRadius: "0.5rem",
    padding: "1rem",
    fontSize: "0.875rem",
    fontFamily: "inherit",
    resize: "none",
  },
  button: {
    background: "linear-gradient(90deg, #2563eb 0%, #06b6d4 100%)",
    color: "white",
    border: "none",
    borderRadius: "0.5rem",
    padding: "0.75rem 1.5rem",
    fontWeight: "600",
    fontSize: "0.875rem",
    transition: "opacity 0.2s",
  },
  completionCard: {
    background: "rgba(5, 150, 105, 0.1)",
    border: "1px solid rgba(16, 185, 129, 0.3)",
    borderRadius: "0.75rem",
    padding: "2rem",
    textAlign: "center",
  },
  completionIcon: {
    fontSize: "3rem",
    marginBottom: "1rem",
  },
  completionTitle: {
    fontSize: "1.5rem",
    fontWeight: "700",
    marginBottom: "0.5rem",
  },
  completionText: {
    color: "#cbd5e1",
    marginBottom: "1.5rem",
    lineHeight: "1.6",
  },
  completionButton: {
    display: "inline-block",
    background: "linear-gradient(90deg, #059669 0%, #10b981 100%)",
    color: "white",
    textDecoration: "none",
    padding: "0.75rem 2rem",
    borderRadius: "0.5rem",
    fontWeight: "600",
    cursor: "pointer",
  },
};
