class CustomError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options)
        this.name = "CustomError"
    }
}

export default CustomError
