import { IStoredGameRecord } from '../game/GameStore';
import { downloadQbj } from '../integrations/file/QbjDownload';

/** Download the portable final result held by a completed local record. */
export function downloadStoredGameQbj(record: IStoredGameRecord): boolean {
  return record.finalQbj !== undefined && downloadQbj(record.finalQbj, record.package);
}
