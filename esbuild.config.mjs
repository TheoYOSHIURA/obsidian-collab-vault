import esbuild from "esbuild";
import { builtinModules } from "node:module";

const watch = process.argv.includes("--watch");
const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  // Fournis par Obsidian : il faut utiliser SES instances de CodeMirror.
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules, ...builtinModules.map(m => "node:" + m)],
});
if (watch) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
