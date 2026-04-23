import { createRoute } from "@tanstack/react-router"
import { Board } from "~/components/Board"
import { Route as rootRoute } from "../__root"

export const Route = createRoute({
	getParentRoute: () => rootRoute,
	path: "/b/$boardId",
	component: BoardPage,
})

function BoardPage() {
	const { boardId } = Route.useParams()

	return <Board boardId={boardId} />
}
