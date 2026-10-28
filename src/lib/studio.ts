export const STUDIO_MAX_SECONDS = 300;
export type StudioSource = { space: 'downloads' | 'share'; path: string };
export type StudioClip = StudioSource & {
	start: number; end: number; audio: number | null; x: number; y: number; title: string; fingerprint: string;
};
export type StudioEdit = { name: string; aspect: '16:9' | '9:16'; clips: StudioClip[]; subtitles: string };
export type StudioProject = StudioEdit & { id: string; createdAt: string; updatedAt: string };
export type StudioMedia = StudioSource & {
	duration: number; width: number; height: number; fingerprint: string;
	audio: { index: number; label: string }[];
};
export type StudioJobKind = 'probe' | 'thumbnail' | 'preview' | 'export';
export type StudioJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type StudioJob = {
	id: string; projectId: string; kind: StudioJobKind; status: StudioJobStatus; progress: number;
	error: string | null; result: StudioMedia | null; createdAt: string; updatedAt: string;
};
export type StudioJobInput = { project: StudioEdit; source?: StudioSource; fingerprint?: string; time?: number };
export type StudioCue = { start: number; end: number; text: string };

export const studioDuration = (clips: StudioClip[]) => clips.reduce((seconds, clip) => seconds + clip.end - clip.start, 0);

// The SRT timeline belongs to the final montage, independently of source timestamps.
export function parseStudioSrt(text: string, duration = STUDIO_MAX_SECONDS): StudioCue[] {
	if (text.length > 10000 || /\u0000/.test(text)) throw new Error('SRT trop volumineux ou invalide.');
	const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
	if (!clean) return [];
	return clean.split(/\n\s*\n/).map((block) => {
		const lines = block.split('\n');
		if (/^\d+$/.test(lines[0])) lines.shift();
		const match = /^(\d{2}):([0-5]\d):([0-5]\d)[,.](\d{3}) --> (\d{2}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(lines.shift() ?? '');
		if (!match) throw new Error('Horaires SRT invalides.');
		const time = (offset: number) => Number(match[offset]) * 3600 + Number(match[offset + 1]) * 60 + Number(match[offset + 2]) + Number(match[offset + 3]) / 1000;
		const start = time(1), end = time(5), body = lines.join('\n').trim();
		if (!body || body.length > 500 || start >= end || end > duration + 0.001) throw new Error('Sous-titre hors du montage ou vide.');
		return { start, end, text: body };
	});
}
