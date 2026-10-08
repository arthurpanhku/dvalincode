import type { DvalinScanner, DvalinScannerId } from '../types.ts';

/**
 * Which engines are enabled after the scanner list is (re)loaded.
 *
 * A newly available engine is switched on for convenience — unless it is
 * remote. A remote engine (Snyk Code uploads source to Snyk) is only ever
 * enabled by the person clicking it: being installed is not consent to send
 * code off the machine. This includes the first load, when every installed
 * engine is "newly available".
 */
export function nextScannerSelection(
  previous: ReadonlySet<DvalinScannerId>,
  previouslyAvailable: ReadonlySet<DvalinScannerId>,
  next: DvalinScanner[],
): Set<DvalinScannerId> {
  return new Set(next
    .filter(scanner => scanner.available)
    .filter(scanner => previous.has(scanner.id) || (!previouslyAvailable.has(scanner.id) && !scanner.remote))
    .map(scanner => scanner.id));
}
