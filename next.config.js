/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  cacheMaxMemorySize: 52 * 1024 * 1024,
  devIndicators: {
    buildActivity: false,
  },
  async headers() {
    const cspHeader = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://login.microsoftonline.com https://cdnjs.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https://app.pulsedashboard.co.uk https://pma.pulsedashboard.co.uk https://*.pulsedashboard.co.uk https://accounts.google.com https://login.microsoftonline.com",
      "frame-src 'self' https://accounts.google.com https://login.microsoftonline.com",
      "frame-ancestors 'self' https://script.google.com https://*.googleusercontent.com",
      "worker-src 'self' blob: https://cdnjs.cloudflare.com",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: cspHeader },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/portal",
        destination: "/pulse",
        permanent: false,
      },
    ];
  },
};

module.exports = nextConfig;