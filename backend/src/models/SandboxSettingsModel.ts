import mongoose, { Schema } from "mongoose"

/** The one document of the collection. */
export const SANDBOX_SETTINGS_ID = "installation"

/**
 * The settings of the coding agent's sandboxes an installation administrator changed from the console, for the whole
 * installation. Each one left out is the environment variable's value, which stays the default.
 */
export interface ISandboxSettings {
    _id: string
    idleMinutes?: number
    maxHours?: number
    sharing?: "domain" | "conversation"
    previewsEnabled?: boolean
    warmSandboxes?: number
    image?: string
    template?: string
    registryHosts?: string
    networkBinary?: string
    /** Changed each time the template in use is changed from the console: not a setting, the sandboxes made before are no longer handed out. */
    templateRevision?: string
    updatedBy?: Schema.Types.ObjectId
    updatedAt?: Date
}

const sandboxSettingsSchema = new Schema<ISandboxSettings>(
    {
        _id: { type: String, required: true },
        idleMinutes: { type: Number },
        maxHours: { type: Number },
        sharing: { type: String, enum: ["domain", "conversation"] },
        previewsEnabled: { type: Boolean },
        warmSandboxes: { type: Number },
        image: { type: String },
        template: { type: String },
        registryHosts: { type: String },
        networkBinary: { type: String },
        templateRevision: { type: String },
        updatedBy: { type: Schema.Types.ObjectId, ref: "User" }
    },
    { timestamps: { createdAt: false, updatedAt: true } }
)

const SandboxSettings = mongoose.model<ISandboxSettings>("SandboxSettings", sandboxSettingsSchema)
export default SandboxSettings
