import { Schema } from "mongoose"
import { DESIGN_SYSTEM_MAX_LENGTH, IDesignSystem } from "../types/DesignSystem"

/** Shared by the organization, its projects and their frontends: each level may replace the one above with its own */
export const designSystemSchema = new Schema<IDesignSystem>(
    {
        packageName: { type: String, required: true, trim: true, maxlength: DESIGN_SYSTEM_MAX_LENGTH.packageName },
        version: { type: String, trim: true, maxlength: DESIGN_SYSTEM_MAX_LENGTH.version },
        docsUrl: { type: String, trim: true, maxlength: DESIGN_SYSTEM_MAX_LENGTH.docsUrl },
        npmrc: { type: String, trim: true, maxlength: DESIGN_SYSTEM_MAX_LENGTH.npmrc },
        notes: { type: String, trim: true, maxlength: DESIGN_SYSTEM_MAX_LENGTH.notes }
    },
    { _id: false }
)
