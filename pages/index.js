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

      // Add user message
      setMessages((prev) => [
        ...prev,
        {
          role: "user",
          text: answer,
          timestamp: new Date(),
        },
      ]);
      setUserAnswer("");

      // Send to API
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
        // Remove user message on error
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
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white p-4">
      <style>{`
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
            'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
            sans-serif;
        }
        .container {
          max-width: 900px;
          margin: 0 auto;
        }
        .header {
          margin-bottom: 2rem;
        }
        .title {
          font-size: 2rem;
          font-weight: 700;
          margin: 0 0 0.5rem 0;
          letter-spacing: -0.02em;
        }
        .subtitle {
          color: #cbd5e1;
          font-size: 0.875rem;
        }
        .progress-bar {
          height: 3px;
          background: #1e293b;
          border-radius: 9999px;
          overflow: hidden;
          margin-top: 1rem;
        }
        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #3b82f6 0%, #06b6d4 100%);
          transition: width 0.5s ease;
        }
        .stage-info {
          margin-bottom: 1.5rem;
          padding: 1rem;
          background: rgba(30, 41, 59, 0.5);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 0.5rem;
        }
        .stage-title {
          font-size: 1.25rem;
          font-weight: 600;
          color: #22d3ee;
          margin: 0 0 0.25rem 0;
        }
        .stage-description {
          color: #94a3b8;
          font-size: 0.875rem;
          margin: 0;
        }
        .chat-container {
          background: rgba(15, 23, 42, 0.6);
          backdrop-filter: blur(8px);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 0.75rem;
          padding: 1.5rem;
          height: 400px;
          overflow-y: auto;
          margin-bottom: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .message {
          animation: slideIn 0.3s ease;
        }
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
        .message-user {
          align-self: flex-end;
          max-width: 80%;
        }
        .message-assistant {
          align-self: flex-start;
          max-width: 80%;
        }
        .message-bubble {
          padding: 0.75rem 1rem;
          border-radius: 0.5rem;
          word-wrap: break-word;
          line-height: 1.5;
          font-size: 0.875rem;
        }
        .message-bubble-user {
          background: #2563eb;
          border-bottom-right-radius: 0.125rem;
        }
        .message-bubble-assistant {
          background: rgba(71, 85, 105, 0.5);
          border-bottom-left-radius: 0.125rem;
          color: #e2e8f0;
        }
        .loading-indicator {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.875rem;
          color: #94a3b8;
        }
        .spinner {
          display: inline-block;
          width: 12px;
          height: 12px;
          border: 2px solid #475569;
          border-top-color: #06b6d4;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .input-area {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .error-banner {
          background: rgba(127, 29, 29, 0.3);
          border: 1px solid rgba(239, 68, 68, 0.5);
          border-radius: 0.5rem;
          padding: 1rem;
          color: #fca5a5;
          font-size: 0.875rem;
          margin-bottom: 1rem;
        }
        textarea {
          width: 100%;
          background: #1e293b;
          color: white;
          border: 1px solid #475569;
          border-radius: 0.5rem;
          padding: 1rem;
          font-size: 0.875rem;
          font-family: inherit;
          resize: none;
          transition: border-color 0.2s;
        }
        textarea:focus {
          outline: none;
          border-color: #06b6d4;
          box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.1);
        }
        textarea:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        button {
          background: linear-gradient(90deg, #2563eb 0%, #06b6d4 100%);
          color: white;
          border: none;
          border-radius: 0.5rem;
          padding: 0.75rem 1.5rem;
          font-weight: 600;
          font-size: 0.875rem;
          cursor: pointer;
          transition: opacity 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
        }
        button:hover:not(:disabled) {
          opacity: 0.9;
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .completion-card {
          background: rgba(5, 150, 105, 0.1);
          border: 1px solid rgba(16, 185, 129, 0.3);
          border-radius: 0.75rem;
          padding: 2rem;
          text-align: center;
        }
        .completion-icon {
          font-size: 3rem;
          margin-bottom: 1rem;
        }
        .completion-title {
          font-size: 1.5rem;
          font-weight: 700;
          margin-bottom: 0.5rem;
        }
        .completion-text {
          color: #cbd5e1;
          margin-bottom: 1.5rem;
          line-height: 1.6;
        }
        .completion-button {
          display: inline-block;
          background: linear-gradient(90deg, #059669 0%, #10b981 100%);
          text-decoration: none;
          padding: 0.75rem 2rem;
          border-radius: 0.5rem;
          font-weight: 600;
          transition: opacity 0.2s;
        }
        .completion-button:hover {
          opacity: 0.9;
        }
        .footer {
          text-align: center;
          color: #64748b;
          font-size: 0.75rem;
          margin-top: 2rem;
        }
      `}</style>

      <div className="container">
        {/* Header */}
        <div className="header">
          <h1 className="title">Alert Triage Setup</h1>
          <p className="subtitle">Building your system knowledge base</p>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Stage Info */}
        {stageInfo && !isComplete && (
          <div className="stage-info">
            <h2 className="stage-title">{stageInfo.title}</h2>
            <p className="stage-description">{stageInfo.description}</p>
            <p className="subtitle">
              Stage {stage + 1} of {totalStages}
            </p>
          </div>
        )}

        {/* Chat Container */}
        {!isComplete && (
          <>
            <div className="chat-container">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`message message-${msg.role}`}
                >
                  <div
                    className={`message-bubble message-bubble-${msg.role}`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="message message-assistant">
                  <div className="loading-indicator">
                    <span className="spinner"></span>
                    Thinking...
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="input-area">
              {error && <div className="error-banner">{error}</div>}

              <textarea
                value={userAnswer}
                onChange={(e) => setUserAnswer(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your answer here... (Ctrl+Enter to submit)"
                rows={4}
                disabled={isLoading}
              />

              <button
                onClick={submitAnswer}
                disabled={!userAnswer.trim() || isLoading}
              >
                {isLoading ? (
                  <>
                    <span className="spinner"></span>
                    Processing...
                  </>
                ) : (
                  "Submit Answer →"
                )}
              </button>
            </div>
          </>
        )}

        {/* Completion Screen */}
        {isComplete && (
          <div className="completion-card">
            <div className="completion-icon">✅</div>
            <h2 className="completion-title">Interview Complete!</h2>
            <p className="completion-text">
              Your knowledge base has been created and saved to Google Docs. You can now
              review it before we move to building the alert triage system.
            </p>
            <a
              href={knowledgeBaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="completion-button"
            >
              View Knowledge Base
            </a>
            <p className="footer">
              Next step: We'll use this knowledge base to build your alert triage UI.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
