import react from "@vitejs/plugin-react-swc"
import { readFileSync } from "fs"
import path from "path"
import { defineConfig } from "vite"

const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"))

// Changes at every build: appended to the assets loaded at runtime (translations) to bust the browser cache
const buildId = `${packageJson.version}.${Date.now().toString(36)}`

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
    define: {
        "import.meta.env.VITE_APP_BUILD_ID": JSON.stringify(buildId)
    },
    server: {
        host: "::",
        proxy: {
            "/api/": {
                target: "http://127.0.0.1:3000/",
                changeOrigin: true,
                rewrite: (path: string) => path.replace(/^\/api/, "")
            },
            // OAuth discovery for MCP clients: served at the origin root, path kept as is
            "/.well-known/oauth-protected-resource": {
                target: "http://127.0.0.1:3000/",
                changeOrigin: true
            },
            "/.well-known/oauth-authorization-server": {
                target: "http://127.0.0.1:3000/",
                changeOrigin: true
            },
            "/.well-known/openid-configuration": {
                target: "http://127.0.0.1:3000/",
                changeOrigin: true
            }
        }
    },
    build: {
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        {
                            // React and the router change only with a dependency bump: out of the entry chunk,
                            // which changes at every release, the browser keeps them cached across releases.
                            // Only libraries every page loads: a group pulls its modules out of the lazy chunks too.
                            name: "react-vendor",
                            test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/
                        }
                    ]
                }
            }
        }
    },
    plugins: [react()].filter(Boolean),
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src")
        }
    }
}))
