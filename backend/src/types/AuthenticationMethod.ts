enum AuthenticationMethod {
    PUBLIC = "PUBLIC",
    API_KEY = "API_KEY",
    /** The token of a maintenance agent, which its container calls the console with */
    MAINTENANCE_AGENT = "MAINTENANCE_AGENT",
    JWT = "JWT"
}

export default AuthenticationMethod
