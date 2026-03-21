import Anthropic from "@anthropic-ai/sdk";
import { google } from "googleapis";
import { createClient } from "redis";

const anthropic = new Anthropic();

// Create Redis client for session storage
const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.connect().catch(console.error);

const INTERVIEW_STAGES = [
  {
    id: "overview",
    title: "System Overview",
    description: "Understanding your automation system setup",
  },
  {
    id: "data_flow",
    title: "Data Flow & Integration",
    description: "How invoices, CRM jobs, and expenses flow through your system",
  },
  {
    id: "sheet_structure",
    title: "Sheet Structure & Fields",
    description: "Column names, data types, and field meanings",
  },
  {
    id: "matching_rules",
    title: "Matching & Reconciliation",
    description: "How the system determines what matches to what",
  },
  {
    id: "alert_patterns",
    title: "Alert Patterns & Edge Cases",
    description: "Common patterns, exceptions, and special cases",
  },
  {
    id: "action_templates",
    title: "Action Templates",
    description: "Standard actions for resolving each alert type",
  },
];

function extractText(message) {
  return message.content[0].type === "text" ? message.content[0].text : "";
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15);
}

async function generateQuestion(stage, context) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `You are interviewing someone about their financial automation system to build a knowledge base.

Stage: ${stage.title}
Description: ${stage.description}

Previous context: ${JSON.stringify(context)}

Ask ONE specific, detailed question about this stage. The question should:
- Be clear and unambiguous
- Expect a substantive answer (not yes/no)
- Build on previous answers if available
- Help understand the technical details

Return ONLY the question, nothing else.`,
      },
    ],
  });

  return extractText(message);
}

async function generateFollowUp(stage, previousAnswer) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 250,
    messages: [
      {
        role: "user",
        content: `Based on this answer about "${stage.title}", generate a follow-up question that digs deeper.

Previous answer: ${previousAnswer}

The follow-up should:
- Ask about a specific aspect they mentioned
- Request examples or edge cases
- Clarify technical details

Return ONLY the follow-up question.`,
      },
    ],
  });

  return extractText(message);
}

async function determineIfComplete(stage, answer) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 20,
    messages: [
      {
        role: "user",
        content: `Do we have enough information about "${stage.title}" to move to the next topic, or should we ask a follow-up?

Answer: ${answer.substring(0, 300)}

Reply with only "complete" or "followup".`,
      },
    ],
  });

  const response = extractText(message).toLowerCase();
  return response.includes("complete");
}

async function extractKnowledge(stage, answer) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 800,
    messages: [
      {
        role: "user",
        content: `Extract and structure the key knowledge from this answer about "${stage.title}".

Answer: ${answer}

Create a JSON object with:
- key_points: array of main concepts
- technical_details: important technical information
- rules_and_patterns: any rules or patterns mentioned
- examples: specific examples given
- followup_questions: any clarifications needed

Return ONLY valid JSON.`,
      },
    ],
  });

  try {
    const content = extractText(message);
    return JSON.parse(content);
  } catch (e) {
    return {
      key_points: [answer],
      raw: answer,
    };
  }
}

async function saveKnowledgeToGoogleDoc(knowledgeBase) {
  // For now, just log and return a placeholder
  // In production, this would save to Google Docs
  console.log("Knowledge base:", JSON.stringify(knowledgeBase, null, 2));
  return `https://docs.google.com/document/d/knowledge-base-${Date.now()}`;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const { action, sessionId, stage, answer } = req.body;

    if (action === "start") {
      const newSessionId = generateSessionId();
      const session = {
        stage: 0,
        responses: {},
        knowledge: {},
      };
      await redisClient.setEx(`session:${newSessionId}`, 86400, JSON.stringify(session)); // 24 hour expiry

      const question = await generateQuestion(INTERVIEW_STAGES[0], {});

      return res.status(200).json({
        success: true,
        sessionId: newSessionId,
        stage: 0,
        totalStages: INTERVIEW_STAGES.length,
        stageInfo: INTERVIEW_STAGES[0],
        question,
      });
    }

    if (action === "answer") {
      const sessionJson = await redisClient.get(`session:${sessionId}`);
      if (!sessionJson) {
        return res.status(404).json({ error: "Session not found" });
      }

      const session = JSON.parse(sessionJson);

      const stageKey = INTERVIEW_STAGES[stage].id;
      session.responses[stageKey] = answer;

      // Extract knowledge
      const knowledge = await extractKnowledge(INTERVIEW_STAGES[stage], answer);
      session.knowledge[stageKey] = knowledge;

      // Determine if we should ask a follow-up
      const isComplete = await determineIfComplete(INTERVIEW_STAGES[stage], answer);

      let nextStage = stage;
      let nextQuestion;
      let isInterviewComplete = false;

      if (!isComplete) {
        // Ask follow-up in same stage
        nextQuestion = await generateFollowUp(INTERVIEW_STAGES[stage], answer);
      } else {
        // Move to next stage
        nextStage = stage + 1;

        if (nextStage >= INTERVIEW_STAGES.length) {
          // Interview complete - save knowledge base
          const docUrl = await saveKnowledgeToGoogleDoc(session.knowledge);
          await redisClient.del(`session:${sessionId}`);
          isInterviewComplete = true;

          return res.status(200).json({
            success: true,
            complete: true,
            knowledgeBaseUrl: docUrl,
          });
        }

        nextQuestion = await generateQuestion(INTERVIEW_STAGES[nextStage], session.knowledge);
        session.stage = nextStage;
      }

      // Save updated session to Redis
      await redisClient.setEx(`session:${sessionId}`, 86400, JSON.stringify(session)); // 24 hour expiry

      return res.status(200).json({
        success: true,
        stage: nextStage,
        totalStages: INTERVIEW_STAGES.length,
        stageInfo: INTERVIEW_STAGES[nextStage],
        question: nextQuestion,
        complete: false,
      });
    }

    res.status(400).json({ error: "Invalid action" });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}