import { type IButtonProps, Tooltip, TooltipContent, TooltipTrigger } from "@flightroom/design-system"
import { forwardRef } from "react"
import { Button } from "@/components/atoms"

export interface EntityCardAction {
    label: string
    icon: React.ReactNode
    onClick: () => void
    primary?: boolean
}

type ActionTileProps = Omit<IButtonProps, "children" | "variant"> & { label: string; icon: React.ReactNode; primary?: boolean }

/**
 * One button of the actions of a card, its icon alone: the label is in the tooltip and read to screen readers. Forwards its ref and props
 * to the button, so it can be the `asChild` trigger of a popover too.
 */
export const ActionTile = forwardRef<HTMLButtonElement | HTMLAnchorElement, ActionTileProps>(({ label, icon, primary, className, ...props }, ref) => (
    <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
            <Button ref={ref} variant={primary ? "primary" : "secondary"} aria-label={label} className={`h-10 w-full min-w-0 px-0 [&_svg]:size-[18px] ${className ?? ""}`} {...props}>
                {icon}
            </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
    </Tooltip>
))

ActionTile.displayName = "ActionTile"

/**
 * The screens of a domain, frontend or backend at the foot of its card, side by side and equally wide. An action left
 * out (the AI one when unavailable) leaves no gap; `children` are further buttons, e.g. the one cloning the repository.
 */
export const EntityCardActions: React.FC<{ actions: (EntityCardAction | false | undefined)[]; children?: React.ReactNode }> = ({ actions, children }) => (
    // The full width of the card: in the flex row of its actions the grid would otherwise grow with its buttons.
    <div className="grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(0,1fr))] gap-2">
        {actions
            .filter((action): action is EntityCardAction => Boolean(action))
            .map(action => (
                <ActionTile key={action.label} label={action.label} icon={action.icon} primary={action.primary} onClick={action.onClick} />
            ))}
        {children}
    </div>
)

/** For the className of an EntityCard: its body is left out when empty, instead of a blank band above the actions. */
export const HIDE_EMPTY_CARD_BODY = "[&>*:empty]:hidden"

export default EntityCardActions
