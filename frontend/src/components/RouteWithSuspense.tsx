import { Spinner } from "@flightroom/design-system"
import { Suspense } from "react"

const RouteWithSuspense = ({ element: Element }: { element: React.ReactNode }) => <Suspense fallback={<Spinner />}>{Element}</Suspense>

export default RouteWithSuspense
