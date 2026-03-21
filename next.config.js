/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  experimental: {
    isrMemoryCacheSize: 52 * 1024 * 1024,
  },
}