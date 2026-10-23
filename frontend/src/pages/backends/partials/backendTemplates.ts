import type { Market } from "@/hooks/apiClients/useMarketApi"

/** Market entries carry their kind in `type`; backends are the ones tagged "service" (any casing). */
export const isBackendTemplate = (market: Pick<Market, "type">) => market.type?.toLowerCase() === "service"
