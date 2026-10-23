import { FastifyInstance } from "fastify"
import { createBusinessException } from "../errors/BusinessException"
import OrganizationService from "../service/OrganizationService"
import ProjectService from "../service/ProjectService"
import UserService from "../service/UserService"
import AuthenticationMethod from "../types/AuthenticationMethod"

export interface StartupUserRegistrationDTO {
    email: string
    password: string
    organization?: string
    /**
     * Kept for older clients. The console now sends only the organization and asks for the first
     * project on the next screen; sent, it still names the organization when that is left out.
     */
    project?: string
}

export function StartupController(fastify: FastifyInstance) {
    const userService = new UserService()

    fastify.get("/startup/users/exists", { config: { authMethod: AuthenticationMethod.PUBLIC } }, async (req, res) => {
        const out = await userService.existsAtLeastOneUser()
        return res.send({ exists: out })
    })

    fastify.post<{ Body: StartupUserRegistrationDTO }>("/startup/registration", { config: { authMethod: AuthenticationMethod.PUBLIC } }, async (req, res) => {
        // The route has to stay public - on an empty installation there is nobody to authenticate
        // as - so what closes it is the only state it exists for: no users yet. Without this it
        // stayed open forever, and called against a populated installation it created another user
        // with an organization and a project of their own.
        //
        // REGISTRATION_ALLOWED deliberately does not gate this one: with registration turned off
        // and no users, an installation could never be set up at all. It gates the ordinary
        // registration route instead - or rather it is supposed to, which is a separate matter.
        //
        // This is a check followed by a write, so two calls racing on a genuinely empty
        // installation could both get through. That window is the first setup itself, and it is
        // the installer's own; what it cannot do any more is stay open afterwards.
        if (await userService.existsAtLeastOneUser()) {
            throw createBusinessException({
                code: "INSTALLATION_ALREADY_SET_UP",
                message: "This installation already has a user: first-startup registration is closed",
                statusCode: 409
            })
        }

        const registeredUser = await userService.register(
            {
                email: req.body.email,
                password: req.body.password
            },
            true
        )

        // The very first user owns the organization everything else hangs from: the project cannot be
        // created before it exists, and the services are built with that user so the ownership check
        // on project creation sees the owner it just created.
        const organizationName = req.body.organization?.trim() || req.body.project?.trim()
        if (!organizationName) {
            throw createBusinessException({
                code: "ORGANIZATION_NAME_REQUIRED",
                message: "The first organization needs a name",
                statusCode: 400
            })
        }

        const organization = await new OrganizationService(registeredUser).create(
            {
                name: organizationName,
                description: organizationName
            },
            registeredUser._id
        )

        // The console leaves the project out: the owner lands on the empty organization and creates
        // the first project there, through the same wizard as every later one.
        const projectName = req.body.project?.trim()
        const project = projectName
            ? await new ProjectService(registeredUser).create(
                  {
                      organizationId: organization._id.toString(),
                      name: projectName,
                      description: projectName
                  },
                  registeredUser._id
              )
            : undefined

        return res.send({ user: registeredUser.toFrontendObject(), organization, project })
    })
}

export default StartupController
