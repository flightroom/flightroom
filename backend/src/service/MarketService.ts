import Market, { IMarket } from "../models/MarketModel"
import BaseAuthorizedService from "./BaseAuthorizedService"
import { BACKEND_TEMPLATES } from "./backendTemplates"

const backendTemplateSlugs = new Set(BACKEND_TEMPLATES.map(template => template.slug))

export class MarketService extends BaseAuthorizedService {
    async getAll(): Promise<IMarket[]> {
        const data = await Market.find().sort({ name: 1 })
        const seededData = await this.seed()
        return [...data, ...seededData.filter(m => !backendTemplateSlugs.has(m.slug)), ...BACKEND_TEMPLATES]
    }

    async getSingle(slug: string): Promise<IMarket | null> {
        const backendTemplate = BACKEND_TEMPLATES.find(m => m.slug === slug)
        if (backendTemplate) {
            return backendTemplate
        }
        const seededData = await this.seed()
        return seededData.find(m => m.slug === slug) || Market.findOne({ slug })
    }

    async seed(): Promise<IMarket[]> {
        const response = await fetch("https://raw.githubusercontent.com/flightroom/documentation/refs/heads/main/marketplace/marketplace.json")
        const data = await response.json()
        return data
    }
}

export default MarketService
