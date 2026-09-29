// Key images are drawn as SVG (144x144 = 72pt @2x) and sent as data URLs.
// Same visual language as the web app: near-black keys, left-aligned type,
// a small color tab per matter, and the running key inverted.

const INK = "#151514";
const PAPER = "#f2f2ef";
const MUTED = "#8a8a84";
const FAINT = "#4a4a46";
const DANGER = "#a4262c";

const SANS = `font-family="'Helvetica Neue', Helvetica, Arial, sans-serif"`;
const MONO = `font-family="Menlo, 'SF Mono', monospace"`;
const X = 16; // left margin

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
export function wrap(label: string, max = 10): string[] {
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
	return lines.map((l) => (l.length > max + 1 ? l.slice(0, max) + "…" : l));
}

function svg(body: string, bg = INK): string {
	const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="${bg}"/>${body}</svg>`;
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(doc)}`;
}

function text(s: string, y: number, { size = 22, weight = 600, fill = PAPER, mono = false } = {}): string {
	return `<text x="${X}" y="${y}" ${mono ? MONO : SANS} font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`;
}

function label(s: string, y: number, fill = PAPER): string {
	return wrap(s)
		.map((l, i) => text(l, y + i * 25, { fill }))
		.join("");
}

const tab = (color: string) => `<rect x="${X}" y="16" width="26" height="5" rx="1" fill="${color}"/>`;

export function matterKey(opts: { label: string; color: string; live: boolean; elapsedMs: number; todayMs: number }): string {
	const { label: name, color, live, elapsedMs, todayMs } = opts;
	if (live) {
		return svg(
			`${tab(color)}${label(name, 50, INK)}${text(clock(elapsedMs), 122, { size: 27, weight: 700, fill: INK, mono: true })}
<rect y="136" width="144" height="8" fill="${color}"/>`,
			PAPER,
		);
	}
	return svg(`${tab(color)}${label(name, 50)}${todayMs ? text(hours(todayMs), 124, { size: 18, weight: 400, fill: MUTED, mono: true }) : ""}`);
}

export function messageKey(title: string, subtitle = "", bg = INK): string {
	return svg(`${label(title, 50)}${subtitle ? text(subtitle, 124, { size: 17, weight: 400, fill: MUTED }) : ""}`, bg);
}

export function stopKey(running: boolean, totalHours: number): string {
	return svg(
		`<rect x="${X}" y="16" width="30" height="30" rx="3" fill="${running ? PAPER : FAINT}"/>
${text("Stop", 88, { fill: running ? PAPER : MUTED })}
${text(`${totalHours.toFixed(1)}h today`, 124, { size: 17, weight: 400, fill: MUTED, mono: true })}`,
	);
}

export function reviewKey(): string {
	return svg(
		`<g stroke="${PAPER}" stroke-width="4" stroke-linecap="round"><line x1="${X}" y1="20" x2="52" y2="20"/><line x1="${X}" y1="32" x2="52" y2="32"/><line x1="${X}" y1="44" x2="38" y2="44"/></g>
${text("Review", 88)}${text("& export", 113, { size: 17, weight: 400, fill: MUTED })}`,
	);
}

const MIC = (fill: string) =>
	`<rect x="${X + 6}" y="14" width="14" height="24" rx="7" fill="${fill}"/>
<path d="M${X} 32 a13 13 0 0 0 26 0" fill="none" stroke="${fill}" stroke-width="3.5" stroke-linecap="round"/>
<line x1="${X + 13}" y1="45" x2="${X + 13}" y2="51" stroke="${fill}" stroke-width="3.5" stroke-linecap="round"/>`;

export function dictateKey(status: "idle" | "recording" | "transcribing" | "disabled", elapsedMs = 0): string {
	if (status === "recording") {
		return svg(`${MIC(PAPER)}${text("Recording", 88)}${text(clock(elapsedMs), 122, { size: 22, weight: 700, mono: true })}`, DANGER);
	}
	if (status === "transcribing") return svg(`${MIC(MUTED)}${text("Writing…", 88, { fill: MUTED })}`);
	const dim = status === "disabled";
	return svg(`${MIC(dim ? FAINT : PAPER)}${text("Dictate", 88, { fill: dim ? MUTED : PAPER })}`);
}

export function nextTaskKey(opts: { active: boolean; task?: number; elapsedMs?: number; color?: string }): string {
	const fill = opts.active ? PAPER : FAINT;
	const chevrons = `<g fill="none" stroke="${fill}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M${X} 18 l12 12 l-12 12"/><path d="M${X + 16} 18 l12 12 l-12 12"/></g>`;
	if (!opts.active) return svg(`${chevrons}${text("Next task", 88, { fill: MUTED })}`);
	return svg(
		`${chevrons}${opts.color ? `<rect x="104" y="18" width="24" height="5" rx="1" fill="${opts.color}"/>` : ""}
${text(`Task ${opts.task}`, 88)}${text(clock(opts.elapsedMs ?? 0), 122, { size: 20, weight: 400, fill: MUTED, mono: true })}`,
	);
}
