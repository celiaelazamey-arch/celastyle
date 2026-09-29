/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source, so Next compiles them as part of
  // the app. Transpiling them here keeps the dev server from needing a
  // separate build step in the monorepo.
  transpilePackages: ["@celastyle/ui", "@celastyle/tokens"],

  // A verification build and a running dev server cannot share one output
  // directory. They overwrite each other's chunks mid-flight, which shows up
  // two ways: the dev server dies with "Cannot find module './819.js'", and
  // the build gate reports a failure for a build that would have passed on its
  // own. Since the gate is served *by* a dev server, that is the normal case,
  // not an edge case.
  //
  // So the gate sets NEXT_DIST_DIR and its build lands in a private directory
  // that no running server is using.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
