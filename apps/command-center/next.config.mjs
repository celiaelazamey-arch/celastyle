/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, so Next compiles them as part of
  // the app. Transpiling them here keeps the dev server from needing a
  // separate build step in the monorepo.
  transpilePackages: ["@celastyle/ui", "@celastyle/tokens"],
};

export default nextConfig;
