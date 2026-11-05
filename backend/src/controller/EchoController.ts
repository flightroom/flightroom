import { FastifyInstance } from "fastify"
import { name, version } from "../../package.json"
import AuthenticationMethod from "../types/AuthenticationMethod"

export default async function echoController(fastify: FastifyInstance) {
    // The Kubernetes probes call it every few seconds: two lines per call would bury the logs that matter
    fastify.get("/echo", { logLevel: "silent", config: { authMethod: AuthenticationMethod.PUBLIC } }, async (request, reply) => {
        reply.send({
            name: name,
            version: version,
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || "prod"
        })
    })
}
