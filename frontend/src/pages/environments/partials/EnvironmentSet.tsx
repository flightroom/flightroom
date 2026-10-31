import { ColorSwatch, IconTile } from "@flightroom/design-system"
import { Globe } from "lucide-react"
import { Badge } from "@/components/atoms"
import { EnvironmentPreset } from "@/utils/EnviromentsPresets"

interface EnvironmentSetProps {
    name: string
    environments: EnvironmentPreset[]
    onClick: (environment: EnvironmentPreset[]) => void
}

/**
 * Un gruppo di ambienti predefiniti. Il bottone e' il nome, allargato con ::after a tutta la tessera:
 * IconTile e Badge sono div, che dentro un <button> non sarebbero HTML valido.
 */
export const EnvironmentSet: React.FC<EnvironmentSetProps> = ({ name, environments, onClick }) => {
    return (
        <div className="relative flex flex-[1_1_240px] flex-wrap items-center gap-4 rounded-lg border-2 border-border bg-card p-4 text-card-foreground transition-colors hover:border-primary hover:bg-primary/10 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary">
            <IconTile size="sm" icon={<Globe />} className="flex-shrink-0" />
            <div className="flex-1">
                <h4>
                    <button
                        type="button"
                        onClick={() => onClick(environments)}
                        data-testid={`environment-preset-${name}`}
                        className="text-left font-medium after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none"
                    >
                        {name}
                    </button>
                </h4>
                <div className="mt-2 flex flex-wrap gap-2">
                    {/* Il colore nel pallino e non come sfondo: con certi colori il testo sopra non si leggerebbe */}
                    {environments.map(env => (
                        <Badge key={env.slug} variant="outline" className="gap-1.5">
                            <ColorSwatch color={env.color} />
                            {env.slug}
                        </Badge>
                    ))}
                </div>
            </div>
        </div>
    )
}

export default EnvironmentSet
