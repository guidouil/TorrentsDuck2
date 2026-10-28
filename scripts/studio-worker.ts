import { db } from '../src/lib/server/db.js';
import { runStudioWorker } from '../src/lib/server/studio-worker.js';

const controller = new AbortController();
const stop = () => controller.abort(new Error('Arrêt du moteur. Vous pouvez relancer le rendu.'));
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
try {
	await runStudioWorker(controller.signal);
} catch {
	console.error('Duck Studio : moteur arrêté. Vérifiez PostgreSQL et la disponibilité du moteur unique.');
	process.exitCode = 1;
} finally {
	process.removeListener('SIGTERM', stop);
	process.removeListener('SIGINT', stop);
	await db.end();
}
