import { createRoute } from "@tanstack/react-router"
import { Board } from "~/components/Board"
import { useWebSocket } from "~/hooks/useWebSocket"
import { Route as rootRoute } from "../__root"

export const Route = createRoute({
	getParentRoute: () => rootRoute,
	path: "/b/$boardId",
	component: BoardPage,
})

function BoardPage() {
	const { boardId } = Route.useParams()
	const { sendOp } = useWebSocket(boardId)

	return <Board sendOp={sendOp} />
}
