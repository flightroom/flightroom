import mongoose, { Document, ObjectId, Schema } from "mongoose"
import { DomainBuildRepository } from "../types/DomainDTO"

/**
 * Where a build and deploy of a domain stands. `building` lasts as long as the request that tags the
 * repositories; every later step is taken by the release tick, so a release survives a restart of the
 * backend and a closed browser.
 */
export enum DomainReleaseStatus {
    BUILDING = "building",
    /** Tagged: waiting for the CI of every tagged repository to register the version */
    WAITING_CI = "waiting_ci",
    UPDATING_VERSIONS = "updating_versions",
    DEPLOYING = "deploying",
    DEPLOYED = "deployed",
    FAILED = "failed"
}

/** The steps a release can fail in: whatever it was doing when it stopped */
export type DomainReleaseStep = DomainReleaseStatus.BUILDING | DomainReleaseStatus.WAITING_CI | DomainReleaseStatus.UPDATING_VERSIONS | DomainReleaseStatus.DEPLOYING

/** A frontend or a service of the domain, as the release found it when it started */
export interface IDomainReleaseMember {
    kind: "frontend" | "service"
    _id: ObjectId
    name: string
    /** Its repository was tagged: without one it is left out of the release, its version untouched */
    tagged: boolean
    /** The CI registered the version of the release for it */
    built: boolean
}

/**
 * One build and deploy of a functional domain: the repositories of its members tagged with `version`,
 * their CI waited for, the version set on every member that was built, the domain deployed to the
 * environment. Every step acts as `startedBy`, with the rights they have when the step runs.
 */
export interface IDomainRelease extends Document<ObjectId> {
    projectId: Schema.Types.ObjectId
    domainId: Schema.Types.ObjectId
    version: string
    ref: string
    environmentId: Schema.Types.ObjectId
    startedBy: Schema.Types.ObjectId
    status: DomainReleaseStatus
    /**
     * Set while the release is not over: the partial unique index on it lets a domain run one release at
     * a time, also when two requests or two instances of the backend start one together.
     */
    active?: boolean
    members: IDomainReleaseMember[]
    /** What the build did, repository by repository: in the refusal of its check, what each would have done */
    repositories: DomainBuildRepository[]
    failedStep?: DomainReleaseStep
    errorCode?: string
    errorMessage?: string
    deploymentId?: Schema.Types.ObjectId
    finishedAt?: Date
    createdAt: Date
    updatedAt: Date
}

const domainReleaseMemberSchema = new Schema<IDomainReleaseMember>(
    {
        kind: { type: String, enum: ["frontend", "service"], required: true },
        _id: { type: Schema.Types.ObjectId, required: true },
        name: { type: String, required: true },
        tagged: { type: Boolean, default: false },
        built: { type: Boolean, default: false }
    },
    { _id: false }
)

const domainReleaseSchema = new Schema<IDomainRelease>(
    {
        projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true },
        domainId: { type: Schema.Types.ObjectId, ref: "Domain", required: true },
        version: { type: String, required: true, maxlength: 128 },
        ref: { type: String, required: true, maxlength: 255 },
        environmentId: { type: Schema.Types.ObjectId, ref: "Environment", required: true },
        startedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        status: { type: String, enum: Object.values(DomainReleaseStatus), default: DomainReleaseStatus.BUILDING, required: true },
        active: { type: Boolean },
        members: { type: [domainReleaseMemberSchema], default: [] },
        // As the build tells them: never queried, only shown
        repositories: { type: Schema.Types.Mixed, default: [] },
        failedStep: { type: String, enum: [DomainReleaseStatus.BUILDING, DomainReleaseStatus.WAITING_CI, DomainReleaseStatus.UPDATING_VERSIONS, DomainReleaseStatus.DEPLOYING] },
        errorCode: { type: String },
        errorMessage: { type: String },
        deploymentId: { type: Schema.Types.ObjectId, ref: "Deployment" },
        finishedAt: { type: Date }
    },
    { timestamps: true }
)

domainReleaseSchema.index({ domainId: 1, createdAt: -1 })
domainReleaseSchema.index({ domainId: 1 }, { name: "domainId_1_active", unique: true, partialFilterExpression: { active: true } })
domainReleaseSchema.index({ status: 1 })

const DomainRelease = mongoose.model<IDomainRelease>("DomainRelease", domainReleaseSchema)
export default DomainRelease
