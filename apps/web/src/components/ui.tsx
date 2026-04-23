import type {
	ButtonHTMLAttributes,
	HTMLAttributes,
	InputHTMLAttributes,
	LabelHTMLAttributes,
	ReactNode,
	TextareaHTMLAttributes,
} from "react"

function cn(...classes: Array<string | false | null | undefined>) {
	return classes.filter(Boolean).join(" ")
}

/* ---------- Layout ---------- */

export function PageShell({
	variant,
	className,
	children,
	...props
}: HTMLAttributes<HTMLDivElement> & { variant: "centered" | "board" }) {
	return (
		<div
			{...props}
			className={cn(
				"min-h-dvh bg-page-bg text-text-primary",
				variant === "centered" &&
					"flex flex-col items-center px-6 pt-[18px] pb-16 max-[900px]:px-4",
				variant === "board" &&
					"px-6 pt-[18px] pb-8 max-[900px]:px-4",
				className,
			)}
		>
			{children}
		</div>
	)
}

export function ContentColumn({
	className,
	children,
	...props
}: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			{...props}
			className={cn("w-full max-w-[576px]", className)}
		>
			{children}
		</div>
	)
}

export function SurfacePanel({
	className,
	as,
	children,
	...props
}: HTMLAttributes<HTMLDivElement> & { as?: "div" | "form" }) {
	const Comp: any = as ?? "div"
	return (
		<Comp
			{...props}
			className={cn(
				"flex flex-col gap-[14px] p-[18px] rounded-xl bg-surface ring-1 ring-inset ring-border-soft",
				className,
			)}
		>
			{children}
		</Comp>
	)
}

export function FieldGroup({
	className,
	children,
	...props
}: HTMLAttributes<HTMLDivElement>) {
	return (
		<div {...props} className={cn("flex flex-col gap-2", className)}>
			{children}
		</div>
	)
}

export function ActionsRow({
	className,
	children,
	...props
}: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			{...props}
			className={cn(
				"flex items-center gap-3 max-[900px]:flex-col max-[900px]:items-stretch",
				className,
			)}
		>
			{children}
		</div>
	)
}

/* ---------- Typography ---------- */

export function DisplayTitle({
	className,
	children,
	...props
}: HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h1
			{...props}
			className={cn(
				"m-0 font-serif font-medium text-[clamp(52px,5vw,74px)] leading-[0.92] tracking-[-0.04em]",
				className,
			)}
		>
			{children}
		</h1>
	)
}

export function PageTitle({
	className,
	children,
	...props
}: HTMLAttributes<HTMLHeadingElement>) {
	return (
		<h1
			{...props}
			className={cn(
				"m-0 font-serif font-medium text-[clamp(42px,4.2vw,60px)] leading-[0.96] tracking-[-0.035em]",
				className,
			)}
		>
			{children}
		</h1>
	)
}

export function SectionTitle({
	as: Tag = "h2",
	className,
	children,
	...props
}: HTMLAttributes<HTMLHeadingElement> & { as?: "h2" | "h3" | "h4" }) {
	return (
		<Tag
			{...props}
			className={cn(
				"m-0 font-serif font-medium text-2xl leading-[1.2]",
				className,
			)}
		>
			{children}
		</Tag>
	)
}

export function BodyCopy({
	className,
	children,
	...props
}: HTMLAttributes<HTMLParagraphElement>) {
	return (
		<p
			{...props}
			className={cn(
				"m-0 text-base leading-[1.5] text-text-primary",
				className,
			)}
		>
			{children}
		</p>
	)
}

export function MutedCopy({
	as: Tag = "p",
	className,
	children,
	...props
}: HTMLAttributes<HTMLElement> & { as?: "p" | "span" | "div" }) {
	return (
		<Tag
			{...props}
			className={cn(
				"m-0 text-sm leading-[1.45] text-text-muted",
				className,
			)}
		>
			{children}
		</Tag>
	)
}

export function MetaLabel({
	className,
	children,
	...props
}: LabelHTMLAttributes<HTMLLabelElement> & { as?: never }) {
	return (
		<label
			{...props}
			className={cn(
				"text-xs leading-4 tracking-[0.12em] uppercase text-text-muted",
				className,
			)}
		>
			{children}
		</label>
	)
}

export function MetaLabelSpan({
	className,
	children,
	...props
}: HTMLAttributes<HTMLSpanElement>) {
	return (
		<span
			{...props}
			className={cn(
				"text-xs leading-4 tracking-[0.12em] uppercase text-text-muted",
				className,
			)}
		>
			{children}
		</span>
	)
}

/* ---------- Buttons ---------- */

const PRIMARY_BUTTON_BASE =
	"inline-flex items-center justify-between gap-4 h-11 px-4 rounded-lg text-white " +
	"bg-gradient-to-b from-[#3b82f6] to-[#2563eb] " +
	"shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_2px_2px_rgb(0_0_0/0.06),0_8px_8px_-8px_rgb(0_0_0/0.08)] " +
	"transition-transform duration-[180ms] hover:-translate-y-px " +
	"disabled:opacity-[0.55] disabled:cursor-not-allowed disabled:transform-none"

export function PrimaryButton({
	label,
	icon = "⊕",
	fullWidth,
	className,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	label: ReactNode
	icon?: ReactNode
	fullWidth?: boolean
}) {
	return (
		<button
			{...props}
			type={type}
			className={cn(PRIMARY_BUTTON_BASE, fullWidth && "w-full", className)}
		>
			<span className="text-[17px] leading-6 font-medium">{label}</span>
			<span aria-hidden="true" className="text-base leading-none">
				{icon}
			</span>
		</button>
	)
}

const CHIP_BASE =
	"inline-flex items-center justify-center h-7 px-[18px] rounded-lg text-[13px] leading-[18px] " +
	"transition-[background-color,box-shadow,transform] duration-[180ms] hover:-translate-y-px"

export function ChipButton({
	variant = "default",
	className,
	type,
	children,
	as,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: "default" | "primary"
	as?: "button" | "a"
} & Record<string, any>) {
	const classes = cn(
		CHIP_BASE,
		variant === "default" &&
			"bg-surface-muted text-text-secondary shadow-[inset_0_0_0_1px_var(--color-border)]",
		variant === "primary" &&
			"bg-gradient-to-b from-[#3b82f6] to-[#2563eb] text-white shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_2px_2px_rgb(0_0_0/0.06),0_8px_8px_-8px_rgb(0_0_0/0.08)]",
		className,
	)
	if (as === "a") {
		return (
			<a {...(props as any)} className={classes}>
				{children}
			</a>
		)
	}
	return (
		<button {...props} type={type ?? "button"} className={classes}>
			{children}
		</button>
	)
}

export function GhostButton({
	muted,
	className,
	children,
	...props
}: HTMLAttributes<HTMLDivElement> & { muted?: boolean }) {
	return (
		<div
			{...props}
			className={cn(
				"flex items-center min-h-[42px] px-[14px] rounded-[10px] text-left",
				"ring-1 ring-inset ring-border-soft",
				muted ? "bg-surface-muted text-text-secondary" : "bg-surface text-text-muted",
				className,
			)}
		>
			{children}
		</div>
	)
}

export function ColumnInlineButton({
	className,
	children,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			{...props}
			type={type}
			className={cn(
				"flex items-center min-h-[42px] px-[14px] rounded-[10px] text-left w-full",
				"bg-surface text-text-muted ring-1 ring-inset ring-border-soft",
				className,
			)}
		>
			{children}
		</button>
	)
}

export function TextAction({
	className,
	type = "button",
	children,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			{...props}
			type={type}
			className={cn(
				"p-0 border-0 bg-transparent text-[15px] leading-[22px] text-text-muted underline underline-offset-[3px] hover:text-text-primary",
				className,
			)}
		>
			{children}
		</button>
	)
}

export function DangerAction({
	className,
	type = "button",
	children,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button
			{...props}
			type={type}
			className={cn(
				"p-0 border-0 bg-transparent text-[15px] leading-[22px] text-danger hover:text-[color-mix(in_srgb,var(--color-danger)_82%,black)]",
				className,
			)}
		>
			{children}
		</button>
	)
}

/* ---------- Inputs ---------- */

const INPUT_SHELL_BASE =
	"w-full border border-border rounded-[10px] bg-[#fbfbfc] text-text-primary outline-none transition-colors duration-[180ms] focus:border-accent"

export function Input({
	className,
	...props
}: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			{...props}
			className={cn(
				INPUT_SHELL_BASE,
				"h-[46px] px-[14px] text-lg leading-6",
				className,
			)}
		/>
	)
}

export function Textarea({
	className,
	...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return (
		<textarea
			{...props}
			className={cn(
				INPUT_SHELL_BASE,
				"min-h-[104px] px-[14px] py-3 text-[15px] leading-[22px] resize-y",
				className,
			)}
		/>
	)
}

export function ColumnTitleInput({
	className,
	...props
}: InputHTMLAttributes<HTMLInputElement>) {
	return (
		<input
			{...props}
			className={cn(
				"w-full px-[10px] py-2 border border-border rounded-[10px] bg-[#fbfbfc] text-text-secondary outline-none",
				"text-xs leading-4 tracking-[0.12em] uppercase",
				className,
			)}
		/>
	)
}

/* ---------- Navigation / headers ---------- */

export function UtilityHeader({
	className,
	children,
	alignStart,
	...props
}: HTMLAttributes<HTMLElement> & { alignStart?: boolean }) {
	return (
		<header
			{...props}
			className={cn(
				"flex items-center justify-between gap-6",
				alignStart && "items-start",
				"max-[900px]:flex-col max-[900px]:items-stretch",
				className,
			)}
		>
			{children}
		</header>
	)
}

export function Brand({
	className,
	children = "Kangent",
	...props
}: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			{...props}
			className={cn(
				"text-[13px] leading-[18px] tracking-[0.14em] uppercase text-text-secondary",
				className,
			)}
		>
			{children}
		</div>
	)
}

export function UtilityNav({
	className,
	align = "end",
	children,
	...props
}: HTMLAttributes<HTMLElement> & { align?: "start" | "end" }) {
	return (
		<nav
			{...props}
			className={cn(
				"flex items-center gap-[14px] flex-wrap",
				align === "end" ? "justify-end" : "justify-start",
				"max-[900px]:justify-start",
				className,
			)}
		>
			{children}
		</nav>
	)
}

export function UtilityLink({
	className,
	children,
	...props
}: HTMLAttributes<HTMLAnchorElement> & { href?: string }) {
	return (
		<a
			{...(props as any)}
			className={cn(
				"text-[13px] leading-[18px] text-text-muted underline underline-offset-[3px]",
				className,
			)}
		>
			{children}
		</a>
	)
}

export function UtilityLinkSpan({
	className,
	children,
	...props
}: HTMLAttributes<HTMLSpanElement>) {
	return (
		<span
			{...props}
			className={cn(
				"text-[13px] leading-[18px] text-text-muted underline underline-offset-[3px]",
				className,
			)}
		>
			{children}
		</span>
	)
}

export function UtilityPill({
	className,
	children,
	...props
}: HTMLAttributes<HTMLSpanElement>) {
	return (
		<span
			{...props}
			className={cn(
				"inline-flex items-center justify-center h-7 px-3 border border-border rounded-full bg-surface text-[13px] leading-[18px] text-text-secondary",
				className,
			)}
		>
			{children}
		</span>
	)
}

/* ---------- NoticeBar ---------- */

export function NoticeBar({
	text,
	meta,
	className,
	...props
}: HTMLAttributes<HTMLDivElement> & { text: ReactNode; meta: ReactNode }) {
	return (
		<div
			{...props}
			className={cn(
				"flex items-center justify-between gap-4 min-h-10 px-4 py-[10px] rounded-lg bg-surface-muted text-text-secondary",
				className,
			)}
		>
			<p className="text-[13px] leading-[18px] m-0">{text}</p>
			<span className="inline-flex items-center gap-2 text-xs leading-4 text-text-muted whitespace-nowrap">
				{meta}
			</span>
		</div>
	)
}

/* ---------- Modal / DetailModal ---------- */

export function Modal({
	onClose,
	children,
}: {
	onClose: () => void
	children: ReactNode
}) {
	return (
		<div
			onClick={onClose}
			className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-[rgb(252_252_251/0.92)] backdrop-blur-[6px]"
		>
			<div
				onClick={(e) => e.stopPropagation()}
				className="w-full max-w-[576px] flex flex-col gap-6"
			>
				{children}
			</div>
		</div>
	)
}

export function DetailModal({
	onClose,
	children,
}: {
	onClose: () => void
	children: ReactNode
}) {
	return (
		<div
			onClick={onClose}
			className="fixed inset-0 z-[60] flex items-center justify-center p-6 bg-[rgb(252_252_251/0.9)] backdrop-blur-[5px]"
		>
			<div
				onClick={(e) => e.stopPropagation()}
				className={cn(
					"w-full max-w-[680px] max-h-[min(80vh,780px)] overflow-auto rounded-[18px] bg-surface",
					"shadow-[inset_0_0_0_1px_var(--color-border-soft),0_24px_64px_-40px_rgb(39_39_42/0.35)]",
				)}
			>
				{children}
			</div>
		</div>
	)
}

export function DetailBody({ children }: { children: ReactNode }) {
	return <div className="p-6">{children}</div>
}

export function DetailFooter({ children }: { children: ReactNode }) {
	return (
		<div className="flex justify-end px-6 pt-[18px] pb-6 border-t border-border">
			{children}
		</div>
	)
}

/* ---------- Toggle ---------- */

export function ToggleRow({
	className,
	children,
	...props
}: HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			{...props}
			className={cn(
				"flex items-center justify-between gap-4",
				"max-[900px]:flex-col max-[900px]:items-stretch",
				className,
			)}
		>
			{children}
		</div>
	)
}

export function Toggle({
	checked,
	onChange,
	className,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	checked: boolean
	onChange: () => void
}) {
	return (
		<button
			{...props}
			type="button"
			aria-pressed={checked}
			onClick={onChange}
			className={cn(
				"relative w-14 h-8 rounded-full border-0 transition-colors duration-[180ms]",
				checked ? "bg-accent" : "bg-border",
				"after:content-[''] after:absolute after:top-1 after:left-1 after:w-6 after:h-6 after:rounded-full after:bg-white after:transition-transform after:duration-[180ms]",
				checked && "after:translate-x-6",
				className,
			)}
		/>
	)
}

/* ---------- Badges / Presence ---------- */

export function AgentBadge({
	className,
	children = "AI",
	...props
}: HTMLAttributes<HTMLSpanElement>) {
	return (
		<span
			{...props}
			className={cn(
				"inline-flex items-center justify-center min-w-7 h-5 px-2 rounded-full text-[11px] leading-[14px] font-semibold",
				"bg-[color-mix(in_srgb,var(--color-accent)_12%,white)] text-accent",
				className,
			)}
		>
			{children}
		</span>
	)
}

export function PresenceStrip({ children }: { children: ReactNode }) {
	return <div className="flex items-center gap-[10px]">{children}</div>
}

export function PresenceBubble({
	human,
	title,
	children,
}: {
	human?: boolean
	title?: string
	children: ReactNode
}) {
	return (
		<div
			title={title}
			className={cn(
				"w-7 h-7 -ml-[6px] rounded-full border-2 border-page-bg",
				"flex items-center justify-center text-xs leading-none font-semibold",
				human
					? "bg-[color-mix(in_srgb,#a78bfa_14%,white)] text-[#7c3aed]"
					: "bg-[color-mix(in_srgb,var(--color-accent)_10%,white)] text-accent",
			)}
		>
			{children}
		</div>
	)
}

export function PresenceDot({
	connected,
	title,
}: {
	connected: boolean
	title?: string
}) {
	return (
		<div
			title={title}
			className={cn(
				"w-2 h-2 rounded-full",
				connected ? "bg-success" : "bg-danger",
			)}
		/>
	)
}

/* ---------- Board card / feature card ---------- */

export function FeatureGrid({
	className,
	children,
	...props
}: HTMLAttributes<HTMLElement>) {
	return (
		<section
			{...props}
			className={cn(
				"grid grid-cols-3 gap-3 max-[900px]:grid-cols-1",
				className,
			)}
		>
			{children}
		</section>
	)
}

export function FeatureCard({
	id,
	title,
	copy,
}: {
	id: ReactNode
	title: ReactNode
	copy: ReactNode
}) {
	return (
		<article className="flex flex-col gap-[10px] p-[14px] rounded-[10px] bg-surface ring-1 ring-inset ring-border-soft">
			<div className="text-xs leading-4 tracking-[0.12em] uppercase text-text-muted">
				{id}
			</div>
			<h2 className="m-0 font-serif font-medium text-[22px] leading-[1.15]">
				{title}
			</h2>
			<p className="m-0 text-sm leading-[1.45] text-text-secondary">{copy}</p>
		</article>
	)
}

export const scrollbarThinClass =
	"[&::-webkit-scrollbar]:w-[6px] [&::-webkit-scrollbar]:h-[6px] " +
	"[&::-webkit-scrollbar-track]:bg-transparent " +
	"[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--color-text-subtle)_50%,transparent)] " +
	"[&::-webkit-scrollbar-thumb]:rounded-full"
