import { type IPageLayoutProps, PageLayout } from "@flightroom/design-system"
import PageHead from "./PageHead"

export type SinglePageHeaderProps = IPageLayoutProps

/** PageLayout del design system con l'head del documento: titolo e descrizione diventano anche title e meta. */
const SinglePageLayout: React.FC<SinglePageHeaderProps> = props => (
    <>
        <PageHead title={props.title} description={props.description} />
        <PageLayout {...props} />
    </>
)

export default SinglePageLayout
