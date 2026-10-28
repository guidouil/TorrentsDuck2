import { readFile, stat } from 'node:fs/promises';
import { cpus } from 'node:os';

const serviceIds = ['web', 'qbittorrent', 'postgres', 'nginx', 'ftp', 'studio'] as const;
const previous = new Map<string, { usage: number; time: number; inode: number }>();

export async function serviceMetrics() {
	const cpuCount = Math.max(1, cpus().length);
	const services = await Promise.all(serviceIds.map(async (id) => {
		try {
			// shortcut: Ubuntu systemd cgroup v2 layout; add other runtimes when service metrics are needed there.
			const path = `/host-cgroup/torrentduck.slice/torrentduck-${id}.slice/cpu.stat`;
			const [contents, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
			const usage = Number(contents.match(/^usage_usec (\d+)$/m)?.[1]);
			if (!Number.isSafeInteger(usage) || usage < 0) throw new Error('Invalid CPU counter');
			const time = performance.now();
			const before = previous.get(id);
			previous.set(id, { usage, time, inode: info.ino });
			const cpuPercent = before && before.inode === info.ino && usage >= before.usage && time > before.time
				? Math.min(100, (usage - before.usage) / ((time - before.time) * 1000 * cpuCount) * 100)
				: null;
			return { id, cpuPercent };
		} catch {
			previous.delete(id);
			return { id, cpuPercent: null };
		}
	}));
	return { cpuCount, services };
}
