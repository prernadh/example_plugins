import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { viteExternalsPlugin } from "vite-plugin-externals";
import path from "path";
import pkg from "./package.json";

const { FIFTYONE_DIR } = process.env;
const IS_DEV = process.env.IS_DEV === "true";

function fiftyonePlugin() {
  return {
    name: "fiftyone-rollup",
    resolveId: {
      order: "pre" as const,
      async handler(source: string) {
        if (source.startsWith("@fiftyone") && FIFTYONE_DIR) {
          const pkgName = source.split("/")[1];
          const modulePath = `${FIFTYONE_DIR}/app/packages/${pkgName}`;
          return this.resolve(modulePath, source, { skipSelf: true });
        }
        return null;
      },
    },
  };
}

export default defineConfig({
  mode: IS_DEV ? "development" : "production",
  plugins: [
    fiftyonePlugin(),
    nodeResolve(),
    react(),
    viteExternalsPlugin({
      react: "React",
      "react-dom": "ReactDOM",
      "@fiftyone/state": "__fos__",
      "@fiftyone/operators": "__foo__",
      "@fiftyone/components": "__foc__",
      "@fiftyone/utilities": "__fou__",
      "@fiftyone/plugins": "__fop__",
      "@fiftyone/spaces": "__fosp__",
    }),
  ],
  build: {
    minify: !IS_DEV,
    lib: {
      entry: path.join(__dirname, pkg.main),
      name: pkg.name,
      fileName: (format) => `index.${format}.js`,
      formats: ["umd"],
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      IS_DEV ? "development" : "production"
    ),
  },
  optimizeDeps: {
    exclude: ["react", "react-dom"],
  },
});
