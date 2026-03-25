/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { dev }) => {
    // Windows dev: persistent pack cache under .next/cache/webpack often corrupts
    // (ENOENT rename / missing ./NNN.js chunks). Memory cache avoids PackFileCacheStrategy.
    if (dev) {
      config.cache = { type: "memory" };
    }
    return config;
  },
};

export default nextConfig;
