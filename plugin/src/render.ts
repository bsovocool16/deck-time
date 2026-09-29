// Key images are drawn as SVG (144x144 = 72pt @2x) and sent as data URLs.

export function clock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = String(s % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function hours(ms: number): string {
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

function esc(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Split a label into at most two lines that fit a key. */
export function wrap(label: string, max = 9): string[] {
	const words = label.trim().split(/\s+/);
	const lines: string[] = [];
	let line = "";
	for (const w of words) {
		if (!line) line = w;
		else if ((line + " " + w).length <= max) line += " " + w;
		else {
			lines.push(line);
			line = w;
		}
	}
	if (line) lines.push(line);
	if (lines.length > 2) lines.splice(1, lines.length - 1, lines.slice(1).join(" "));
	return lines.map((l) => (l.length > max + 2 ? l.slice(0, max + 1) + "…" : l));
}

function svg(body: string, bg: string): string {
	const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" rx="0" fill="${bg}"/>${body}</svg>`;
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(doc)}`;
}

const FONT = `font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"`;

function labelLines(label: string, y0: number, size: number): string {
	const lines = wrap(label);
	const start = lines.length === 1 ? y0 : y0 - size * 0.55;
	return lines
		.map(
			(l, i) =>
				`<text x="72" y="${start + i * size * 1.1}" text-anchor="middle" ${FONT} font-size="${size}" font-weight="700" fill="#fff">${esc(l)}</text>`,
		)
		.join("");
}

export function matterKey(opts: { label: string; color: string; live: boolean; elapsedMs: number; todayMs: number }): string {
	const { label, color, live, elapsedMs, todayMs } = opts;
	if (live) {
		return svg(
			`<rect x="6" y="6" width="132" height="132" rx="14" fill="none" stroke="#fff" stroke-width="5"/>
${labelLines(label, 58, 24)}
<text x="72" y="116" text-anchor="middle" ${FONT} font-size="30" font-weight="800" fill="#fff">${clock(elapsedMs)}</text>`,
			color,
		);
	}
	return svg(
		`${labelLines(label, 66, 24)}
<rect x="42" y="94" width="60" height="6" rx="3" fill="${color}"/>
${todayMs ? `<text x="72" y="126" text-anchor="middle" ${FONT} font-size="20" fill="#9ca3af">${hours(todayMs)}</text>` : ""}`,
		"#111418",
	);
}

export function messageKey(title: string, subtitle = "", bg = "#111418"): string {
	return svg(
		`${labelLines(title, 68, 24)}
${subtitle ? `<text x="72" y="118" text-anchor="middle" ${FONT} font-size="18" fill="#9ca3af">${esc(subtitle)}</text>` : ""}`,
		bg,
	);
}

export function stopKey(running: boolean, totalHours: number): string {
	return svg(
		`<rect x="47" y="30" width="50" height="50" rx="8" fill="${running ? "#ef4444" : "#4b5563"}"/>
<text x="72" y="120" text-anchor="middle" ${FONT} font-size="24" font-weight="700" fill="#fff">${totalHours.toFixed(1)}h</text>`,
		"#111418",
	);
}

export function reviewKey(): string {
	return svg(
		`<g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round">
<line x1="44" y1="38" x2="100" y2="38"/><line x1="44" y1="58" x2="100" y2="58"/><line x1="44" y1="78" x2="80" y2="78"/></g>
<text x="72" y="122" text-anchor="middle" ${FONT} font-size="22" font-weight="700" fill="#fff">Review</text>`,
		"#1d4ed8",
	);
}

const MIC = (fill: string) =>
	`<rect x="58" y="22" width="28" height="48" rx="14" fill="${fill}"/>
<path d="M46 58 a26 26 0 0 0 52 0" fill="none" stroke="${fill}" stroke-width="6" stroke-linecap="round"/>
<line x1="72" y1="84" x2="72" y2="96" stroke="${fill}" stroke-width="6" stroke-linecap="round"/>`;

export function dictateKey(status: "idle" | "recording" | "transcribing" | "disabled", elapsedMs = 0): string {
	if (status === "recording") {
		return svg(`${MIC("#fff")}<text x="72" y="128" text-anchor="middle" ${FONT} font-size="24" font-weight="800" fill="#fff">${clock(elapsedMs)}</text>`, "#dc2626");
	}
	if (status === "transcribing") {
		return svg(`${MIC("#9ca3af")}<text x="72" y="128" text-anchor="middle" ${FONT} font-size="20" font-weight="700" fill="#fff">Writing…</text>`, "#111418");
	}
	const dim = status === "disabled";
	return svg(`${MIC(dim ? "#4b5563" : "#fff")}<text x="72" y="128" text-anchor="middle" ${FONT} font-size="20" font-weight="700" fill="${dim ? "#6b7280" : "#fff"}">Dictate</text>`, "#111418");
}

export function nextTaskKey(opts: { active: boolean; task?: number; elapsedMs?: number; color?: string }): string {
	const fg = opts.active ? "#fff" : "#4b5563";
	const icon = `<path d="M34 30 L74 58 L34 86 Z" fill="${fg}"/><path d="M70 30 L110 58 L70 86 Z" fill="${fg}"/>`;
	if (!opts.active) {
		return svg(`${icon}<text x="72" y="124" text-anchor="middle" ${FONT} font-size="20" font-weight="700" fill="#6b7280">Next task</text>`, "#111418");
	}
	return svg(
		`${icon}<rect x="0" y="0" width="144" height="8" fill="${opts.color ?? "#3b82f6"}"/>
<text x="72" y="116" text-anchor="middle" ${FONT} font-size="20" font-weight="700" fill="#fff">Task ${opts.task}</text>
<text x="72" y="136" text-anchor="middle" ${FONT} font-size="16" fill="#9ca3af">${clock(opts.elapsedMs ?? 0)}</text>`,
		"#111418",
	);
}
