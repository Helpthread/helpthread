/** @type {import('next').NextConfig} */
const nextConfig = {
  // The engine is Node-bound (node:crypto HMAC) and so is this app's API
  // access; nothing here targets the Edge runtime.
  reactStrictMode: true,
}

export default nextConfig
