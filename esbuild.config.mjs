import * as esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");
const isTest = process.argv.includes("--test");

const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

const testBuildOptions = {
  entryPoints: [
    "test/nexamindClient.test.ts",
    "test/integration.test.ts",
    "test/workspace.test.ts",
    "test/attachmentRegression.test.ts",
    "test/intentAndLifecycle.test.ts",
    "test/loginFlow.test.ts",
    "test/branding.test.ts",
  ],
  bundle: true,
  outdir: "dist-test",
  outExtension: { ".js": ".mjs" },
  alias: {
    vscode: "./test/vscodeMock.ts",
  },
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: true,
  logLevel: "info",
};

async function main() {
  if (isTest) {
    await esbuild.build(testBuildOptions);
    console.log("Test build complete.");
    return;
  }

  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(buildOptions);
    console.log("Build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
