/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  // Load *.md files (e.g. src/content/cheatsheet.md) as raw strings so they
  // can be passed straight to react-markdown.
  webpack: (config) => {
    config.module.rules.push({
      test: /\.md$/,
      type: 'asset/source',
    });
    return config;
  },
};

export default nextConfig;
