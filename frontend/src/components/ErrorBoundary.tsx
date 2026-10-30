import { Component, type ErrorInfo, type ReactNode } from "react"

interface ErrorBoundaryProps {
    /** Shown in place of the children once they throw while rendering, a lazy chunk that fails to load included. */
    fallback: ReactNode
    children: ReactNode
}

interface ErrorBoundaryState {
    hasError: boolean
}

/**
 * Keeps an error in one part of the page from unmounting the whole app: React has no other way to
 * catch a render error than a class component.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { hasError: false }

    static getDerivedStateFromError(): ErrorBoundaryState {
        return { hasError: true }
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error("Render error caught by ErrorBoundary:", error, info.componentStack)
    }

    render() {
        return this.state.hasError ? this.props.fallback : this.props.children
    }
}

export default ErrorBoundary
