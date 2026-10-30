// Loaded on its own chunk by MicrosoftAuthWrapper. The package root is imported statically too
// (msal-react, the login button), so `import("@azure/msal-browser")` would keep the whole client
// in the entry chunk: re-exported from here, only what is used elsewhere stays there.
export { EventType, PublicClientApplication } from "@azure/msal-browser"
