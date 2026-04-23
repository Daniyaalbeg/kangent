import { Route as rootRoute } from "./routes/__root"
import { Route as indexRoute } from "./routes/index"
import { Route as boardRoute } from "./routes/b/$boardId"

const indexRouteWithChildren = indexRoute

const boardRouteWithChildren = boardRoute

const routeTree = rootRoute.addChildren([indexRouteWithChildren, boardRouteWithChildren])

export { routeTree }
