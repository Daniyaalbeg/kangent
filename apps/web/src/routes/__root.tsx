import { Outlet, createRootRoute } from "@tanstack/react-router"
import { Agentation } from "agentation"
import { InterfaceKit } from "interface-kit/react"

export const Route = createRootRoute({
	component: RootComponent,
})

function RootComponent() {
	return (
		<>
			<Outlet />
			{process.env.NODE_ENV === "development" && <InterfaceKit />}
			{process.env.NODE_ENV === "development" && <Agentation />}
		</>
	)
}
