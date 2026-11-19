export default async function handler(req, res) {
  const origin = req.headers.origin;
  const isAllowedOrigin = origin && (
    origin === "https://app.pulsedashboard.co.uk" ||
    origin === "https://pulsedashboard.co.uk" ||
    origin === "https://pma.pulsedashboard.co.uk" ||
    (process.env.NODE_ENV !== "production" && origin === "http://localhost:3000")
  );

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", isAllowedOrigin ? origin : "https://app.pulsedashboard.co.uk");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  return res.status(410).json({
    valid: false,
    message: "Legacy GAS SSO verification endpoint has been decommissioned."
  });
}
