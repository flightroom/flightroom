import { FastifyBaseLogger, FastifyInstance } from "fastify"
import fastifyPlugin from "fastify-plugin"
import mongoose from "mongoose"
import { runMigrations } from "../utils/migrations"

export let noSQLClient: mongoose.Mongoose
export let isReplicaSet: boolean = false

/** Tells whether the database is a replica set, before the data migrations run */
const checkReplicaSet = async (log: FastifyBaseLogger): Promise<void> => {
    noSQLClient = mongoose
    const admin = noSQLClient.connection.db?.admin()
    if (!admin) {
        log.error("Admin database not found")
        return
    }
    const info = await admin.command({ hello: 1 }) // fallback a { isMaster: 1 } per versioni molto vecchie

    if (info.setName) {
        log.info(`Connected to replica set: ${info.setName}`)
        isReplicaSet = true
    } else {
        log.warn("Connected to standalone MongoDB (not replica set)")
        isReplicaSet = false
    }
}

/**
 * Once connected: the replica set check, whose failure is only logged, then the migrations, whose failure
 * fails the boot. runMigrations swallows the failures the console can run with, so whatever it lets
 * through is one it cannot.
 */
export const onConnected = async (log: FastifyBaseLogger, done: (error?: Error) => void): Promise<void> => {
    try {
        await checkReplicaSet(log)
    } catch (e) {
        log.error({ error: e }, "Error while checking replica set status:")
    }
    try {
        await runMigrations(log)
    } catch (error) {
        log.error({ error }, "A data migration failed: the application does not start")
        done(error instanceof Error ? error : new Error(String(error)))
        return
    }
    done()
}

export default fastifyPlugin(
    (fastify: FastifyInstance, opts, done) => {
        try {
            if (!fastify.config.NOSQL_DATABASE_URL) {
                fastify.log.warn("Cannot see MongoDB database URL, will not connect")
                // Still done: leaving the plugin hanging would time out the boot, so an installation
                // started without a database would never answer, not even to say it has none.
                done()
                return
            }

            fastify.log.info("Start connecting mongo DB")

            // Configure Mongoose for replica set
            const options: mongoose.ConnectOptions = {
                user: fastify.config.NOSQL_DATABASE_USERNAME,
                pass: fastify.config.NOSQL_DATABASE_PASSWORD,
                dbName: fastify.config.NOSQL_DATABASE_NAME,
                retryWrites: true,
                w: "majority"
            }

            mongoose.connect(fastify.config.NOSQL_DATABASE_URL, options)

            // Verify the connection is to a replica set
            const connection = mongoose.connection
            connection.on("connected", () => onConnected(fastify.log, done))

            connection.on("error", err => {
                fastify.log.error("MongoDB connection error:", err)
                done(err)
            })

            fastify.log.info("MongoDB started connection....")
        } catch (err) {
            fastify.log.error({ error: err }, "MongoDB connection error:")
            throw err
        }
    },
    { name: "noSQL", dependencies: ["config"] }
)
