import type { Auth0ContextInterface } from "@auth0/auth0-react"
import { createContext, useContext } from "react"

/** What the console reads of the Auth0 state: the default below has to cover it. */
type Auth0State = Pick<Auth0ContextInterface, "isAuthenticated" | "isLoading" | "user" | "error" | "getAccessTokenSilently" | "loginWithPopup" | "logout">

const notProvided = (): never => {
    throw new Error("You forgot to wrap your component in <Auth0Provider>.")
}

// Without a provider: what useAuth0 of the SDK answers there, nobody signed in and every method throwing
const noProvider: Auth0State = {
    isAuthenticated: false,
    isLoading: true,
    user: undefined,
    error: undefined,
    getAccessTokenSilently: notProvided,
    loginWithPopup: notProvided,
    logout: notProvided
}

/**
 * The context the Auth0Provider of Auth0AuthWrapper fills, kept out of @auth0/auth0-react: the SDK
 * is downloaded only where Auth0 login is configured, while the API client and the user menu read
 * this state on every page.
 */
export const Auth0Context = createContext<Auth0State>(noProvider)

export const useAuth0 = (): Auth0State => useContext(Auth0Context)
