/** The length of the rocket as drawn, nose to fins, before scaling to `size`. */
const ROCKET_LENGTH = 36

interface RocketOptions {
    /** The colour of the porthole; the body colour darkened when missing. */
    windowColor?: string
    /** The colour of the exhaust; no exhaust when missing. */
    flameColor?: string
    /** How long the exhaust is, in the units of an unscaled rocket (36 long). */
    flame?: number
}

/**
 * The rocket of the deploy game and of the agents in the galaxy: centred on `x, y`, its nose pointing
 * along `angle` (radians, 0 = right), `size` long in the units of the context.
 */
export const drawRocket = (ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, size: number, color: string, options: RocketOptions = {}) => {
    const { windowColor, flameColor, flame = 0 } = options
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    ctx.scale(size / ROCKET_LENGTH, size / ROCKET_LENGTH)

    if (flameColor && flame > 0) {
        ctx.fillStyle = flameColor
        ctx.beginPath()
        ctx.moveTo(-14, -6)
        ctx.lineTo(-14 - flame, 0)
        ctx.lineTo(-14, 6)
        ctx.fill()
    }

    ctx.fillStyle = color
    ctx.beginPath()
    ctx.ellipse(0, 0, 18, 9, 0, 0, Math.PI * 2)
    ctx.moveTo(-10, -7)
    ctx.lineTo(-18, -15)
    ctx.lineTo(-4, -7)
    ctx.moveTo(-10, 7)
    ctx.lineTo(-18, 15)
    ctx.lineTo(-4, 7)
    ctx.fill()

    ctx.fillStyle = windowColor ?? "rgb(0 0 0 / 0.35)"
    ctx.beginPath()
    ctx.arc(6, 0, 4, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
}

export default drawRocket
