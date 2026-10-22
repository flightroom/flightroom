import { IUser } from "../models/UserModel"
import CustomError from "./CustomError"

export default class UserCannotAccessThisOrganizationError extends CustomError {
    /**
     * Fastify reads statusCode off the error to pick the response code: without it a member who is
     * not an admin of the organization got a 500, as if the server had crashed, instead of a refusal.
     */
    public readonly statusCode = 403

    constructor(user?: IUser) {
        super(`User ${user?.email} cannot access this organization`)
        this.name = "UserCannotAccessThisOrganizationError"
        Object.setPrototypeOf(this, UserCannotAccessThisOrganizationError.prototype)
    }

    static isInstance(error: unknown): error is UserCannotAccessThisOrganizationError {
        return error instanceof UserCannotAccessThisOrganizationError
    }
}
