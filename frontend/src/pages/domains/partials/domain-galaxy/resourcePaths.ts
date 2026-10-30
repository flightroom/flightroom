import { resourceTypeGlyph } from "@/components/resource/resourceIcons"

/** The logos of the resources, parsed once: a moon is painted on every frame */
const brandPaths = new Map<string, Path2D>()
export const brandPath = (path: string) => {
    let parsed = brandPaths.get(path)
    if (!parsed) {
        parsed = new Path2D(path)
        brandPaths.set(path, parsed)
    }
    return parsed
}

/**
 * The lucide icon of a resource type as one path to stroke: lucide-react exports only the components, so it
 * is read from the markup of the same icons, the few kinds of elements they use.
 */
const glyphPaths = new Map<string, Path2D>()
export const glyphPath = (type: string) => {
    let parsed = glyphPaths.get(type)
    if (parsed) return parsed
    parsed = new Path2D()
    for (const [, tag, attributes] of resourceTypeGlyph(type).matchAll(/<(\w+)([^>]*)\/>/g)) {
        const values = new Map([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))
        const n = (name: string) => Number(values.get(name) ?? 0)
        if (tag === "path") parsed.addPath(new Path2D(values.get("d")))
        else if (tag === "circle") {
            parsed.moveTo(n("cx") + n("r"), n("cy"))
            parsed.arc(n("cx"), n("cy"), n("r"), 0, 2 * Math.PI)
        } else if (tag === "ellipse") {
            parsed.moveTo(n("cx") + n("rx"), n("cy"))
            parsed.ellipse(n("cx"), n("cy"), n("rx"), n("ry"), 0, 0, 2 * Math.PI)
        } else if (tag === "rect") parsed.roundRect(n("x"), n("y"), n("width"), n("height"), n("rx"))
    }
    glyphPaths.set(type, parsed)
    return parsed
}
